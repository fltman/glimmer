"""upscale Celery task — server-side super-resolution. Queue: `heavy`.

Routing: prefer fal.ai (Clarity/ESRGAN) when FAL_KEY is set, else Replicate
(Real-ESRGAN) when REPLICATE_API_TOKEN is set, else fail with a clear
`no_upscale_provider` error (the browser handles the client-side ONNX path).

Output is normalized to PNG and re-aligned to scale*input dimensions when the
provider's result differs.

`inputs` is an UpscaleInputs dict: {image: AssetRef, scale: 2|4}.
"""

from __future__ import annotations

import logging
from io import BytesIO

from PIL import Image

from ..celery_app import app
from ..config import settings
from ..contracts import Job, JobArtifact, new_job, now_iso
from ..providers import fal, replicate
from ..providers.openrouter import ProviderError
from ..redis_io import load_job, publish_progress
from ..storage import build_key, download_object, presign_get, sha256_hex, upload_bytes

log = logging.getLogger("aips.tasks.upscale")

TASK_NAME = "aips.upscale"


def _fail(job: Job, code: str, message: str) -> None:
    job["status"] = "failed"
    job["stage"] = "done"
    job["progress"] = 1.0
    job["error"] = {"code": code, "message": message}
    job["finishedAt"] = now_iso()
    publish_progress(job)


def _lanczos_upscale(image_bytes: bytes, scale: int) -> bytes:
    """Zero-config fallback upscaler: high-quality Lanczos resample.

    Not AI super-resolution, but it always works without any provider key and
    gives a clean, sharp 2x/4x. fal.ai/Replicate (when configured) replace this
    with a learned upscaler for finer detail.
    """
    src = Image.open(BytesIO(image_bytes)).convert("RGBA")
    out = src.resize((src.width * scale, src.height * scale), Image.LANCZOS)
    buf = BytesIO()
    out.save(buf, format="PNG")
    return buf.getvalue()


@app.task(name=TASK_NAME, bind=True)
def upscale(self, *, job_id: str, inputs: dict, user_id: str = "anon", idempotency_key=None):
    job: Job = load_job(job_id) or new_job(job_id, "upscale")  # type: ignore[arg-type]

    if job.get("status") == "succeeded":
        return {"jobId": job_id, "status": "succeeded"}

    inputs = inputs or {}
    image_ref = inputs.get("image") or {}
    scale = int(inputs.get("scale") or 2)
    if not image_ref.get("key"):
        _fail(job, "invalid_inputs", "upscale requires inputs.image.key")
        return {"jobId": job_id, "status": "failed"}
    if scale not in (2, 4):
        _fail(job, "invalid_inputs", f"upscale scale must be 2 or 4, got {scale}")
        return {"jobId": job_id, "status": "failed"}

    # Pick a provider up front so we can fail fast (and label providerResolved).
    if settings.fal_key:
        do_upscale, provider_name = fal.upscale, "fal.ai"
    elif settings.replicate_api_token:
        do_upscale, provider_name = replicate.upscale, "replicate"
    else:
        # No learned-upscaler provider configured → fall back to a local
        # Lanczos resample so the feature still works out of the box.
        do_upscale, provider_name = _lanczos_upscale, "lanczos"

    job["providerResolved"] = provider_name
    job["status"] = "running"
    job["stage"] = "calling_model"
    job["progress"] = 0.15
    publish_progress(job)

    try:
        image_bytes = download_object(image_ref["key"])
    except Exception as exc:  # noqa: BLE001
        log.exception("upscale download failed job=%s", job_id)
        _fail(job, "storage_error", f"Could not download input image: {exc}")
        return {"jobId": job_id, "status": "failed"}

    job["progress"] = 0.4
    publish_progress(job)
    try:
        out_bytes = do_upscale(image_bytes, scale)
    except ProviderError as exc:
        log.warning("upscale provider error job=%s code=%s: %s", job_id, exc.code, exc.message)
        _fail(job, exc.code, exc.message)
        return {"jobId": job_id, "status": "failed"}
    except Exception as exc:  # noqa: BLE001
        log.exception("upscale unexpected error job=%s", job_id)
        _fail(job, "internal_error", str(exc))
        return {"jobId": job_id, "status": "failed"}

    # Normalize to PNG; re-align to scale*input if the provider missed the target.
    job["stage"] = "post_processing"
    job["progress"] = 0.85
    publish_progress(job)
    try:
        img = Image.open(BytesIO(out_bytes)).convert("RGBA")
        src = Image.open(BytesIO(image_bytes))
        target = (src.width * scale, src.height * scale)
        if img.size != target:
            img = img.resize(target, Image.LANCZOS)
        buf = BytesIO()
        img.save(buf, format="PNG")
        png = buf.getvalue()
    except Exception as exc:  # noqa: BLE001
        log.exception("upscale post-processing failed job=%s", job_id)
        _fail(job, "decode_failed", f"Could not process upscaled image: {exc}")
        return {"jobId": job_id, "status": "failed"}

    digest = sha256_hex(png)
    key = build_key(user_id, digest, "png")
    try:
        upload_bytes(key, png, "image/png")
    except Exception as exc:  # noqa: BLE001
        log.exception("upscale upload failed job=%s", job_id)
        _fail(job, "storage_error", f"Failed to store result: {exc}")
        return {"jobId": job_id, "status": "failed"}

    artifact: JobArtifact = {
        "kind": "image",
        "url": presign_get(key, expires_seconds=24 * 60 * 60),
        "contentType": "image/png",
        "width": img.width,
        "height": img.height,
        "placement": {
            "roi": {"x": 0, "y": 0, "width": img.width, "height": img.height},
            "suggestedLayerName": f"Upscaled {scale}x",
        },
    }
    job["artifacts"] = [artifact]
    job["status"] = "succeeded"
    job["stage"] = "done"
    job["progress"] = 1.0
    job["finishedAt"] = now_iso()
    publish_progress(job)

    return {"jobId": job_id, "status": "succeeded", "key": key}
