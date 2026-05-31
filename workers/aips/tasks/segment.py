"""segment Celery task — subject/foreground mask. Queue: `fast`.

Routing: prefer fal.ai (BiRefNet/SAM) when FAL_KEY is set, else Replicate (SAM)
when REPLICATE_API_TOKEN is set, else fail with `no_segment_provider`. Produces a
single-channel mask PNG artifact (kind="mask"), sized to the input, used later by
select-subject and as an inpaint mask source.

`inputs` is a SegmentInputs dict:
  {image: AssetRef, points?: [{x,y,label}], box?: Rect}.
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

log = logging.getLogger("aips.tasks.segment")

TASK_NAME = "aips.segment"


def _fail(job: Job, code: str, message: str) -> None:
    job["status"] = "failed"
    job["stage"] = "done"
    job["progress"] = 1.0
    job["error"] = {"code": code, "message": message}
    job["finishedAt"] = now_iso()
    publish_progress(job)


@app.task(name=TASK_NAME, bind=True)
def segment(self, *, job_id: str, inputs: dict, user_id: str = "anon", idempotency_key=None):
    job: Job = load_job(job_id) or new_job(job_id, "segment")  # type: ignore[arg-type]

    if job.get("status") == "succeeded":
        return {"jobId": job_id, "status": "succeeded"}

    inputs = inputs or {}
    image_ref = inputs.get("image") or {}
    if not image_ref.get("key"):
        _fail(job, "invalid_inputs", "segment requires inputs.image.key")
        return {"jobId": job_id, "status": "failed"}

    points = inputs.get("points")
    box = inputs.get("box")

    if settings.fal_key:
        do_segment, provider_name = fal.segment, "fal.ai"
    elif settings.replicate_api_token:
        do_segment, provider_name = replicate.segment, "replicate"
    else:
        _fail(
            job,
            "no_segment_provider",
            "No server segment provider configured (set FAL_KEY or REPLICATE_API_TOKEN).",
        )
        return {"jobId": job_id, "status": "failed"}

    job["providerResolved"] = provider_name
    job["status"] = "running"
    job["stage"] = "calling_model"
    job["progress"] = 0.2
    publish_progress(job)

    try:
        image_bytes = download_object(image_ref["key"])
    except Exception as exc:  # noqa: BLE001
        log.exception("segment download failed job=%s", job_id)
        _fail(job, "storage_error", f"Could not download input image: {exc}")
        return {"jobId": job_id, "status": "failed"}

    job["progress"] = 0.5
    publish_progress(job)
    try:
        mask_bytes = do_segment(image_bytes, points=points, box=box)
    except ProviderError as exc:
        log.warning("segment provider error job=%s code=%s: %s", job_id, exc.code, exc.message)
        _fail(job, exc.code, exc.message)
        return {"jobId": job_id, "status": "failed"}
    except Exception as exc:  # noqa: BLE001
        log.exception("segment unexpected error job=%s", job_id)
        _fail(job, "internal_error", str(exc))
        return {"jobId": job_id, "status": "failed"}

    # Normalize to a single-channel (L) mask PNG sized to the input image.
    job["stage"] = "post_processing"
    job["progress"] = 0.85
    publish_progress(job)
    try:
        src = Image.open(BytesIO(image_bytes))
        mask = Image.open(BytesIO(mask_bytes)).convert("L")
        if mask.size != src.size:
            mask = mask.resize(src.size, Image.LANCZOS)
        buf = BytesIO()
        mask.save(buf, format="PNG")
        png = buf.getvalue()
    except Exception as exc:  # noqa: BLE001
        log.exception("segment post-processing failed job=%s", job_id)
        _fail(job, "decode_failed", f"Could not process mask: {exc}")
        return {"jobId": job_id, "status": "failed"}

    digest = sha256_hex(png)
    key = build_key(user_id, digest, "png")
    try:
        upload_bytes(key, png, "image/png")
    except Exception as exc:  # noqa: BLE001
        log.exception("segment upload failed job=%s", job_id)
        _fail(job, "storage_error", f"Failed to store mask: {exc}")
        return {"jobId": job_id, "status": "failed"}

    artifact: JobArtifact = {
        "kind": "mask",
        "url": presign_get(key, expires_seconds=24 * 60 * 60),
        "contentType": "image/png",
        "width": mask.width,
        "height": mask.height,
        "placement": {
            "roi": {"x": 0, "y": 0, "width": mask.width, "height": mask.height},
            "suggestedLayerName": "Selection mask",
        },
    }
    job["artifacts"] = [artifact]
    job["status"] = "succeeded"
    job["stage"] = "done"
    job["progress"] = 1.0
    job["finishedAt"] = now_iso()
    publish_progress(job)

    return {"jobId": job_id, "status": "succeeded", "key": key}
