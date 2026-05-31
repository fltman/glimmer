"""upscale Celery task — server-side super-resolution. Queue: `heavy`.

Routing: prefer fal.ai (Clarity/ESRGAN) when FAL_KEY is set, else Replicate
(Real-ESRGAN) when REPLICATE_API_TOKEN is set, else fall back to a local Lanczos
resample (always works, no key required).

When `inputs.creativity > 0`, a second "enhance" pass runs the upscaled image
through the OpenRouter (Gemini) img2img model to sharpen textures and synthesize
fine detail — tiled when the image is large — and the result is color-matched
back to the base upscale so colors/composition don't drift. This works with ONLY
OpenRouter configured (no fal/Replicate key needed).

Output is normalized to PNG and re-aligned to scale*input dimensions when the
provider's result differs.

`inputs` is an UpscaleInputs dict: {image: AssetRef, scale: 2|4, creativity?: 0..1}.
"""

from __future__ import annotations

import logging
from io import BytesIO

from PIL import Image

from ..celery_app import app
from ..config import settings
from ..contracts import Job, JobArtifact, new_job, now_iso
from ..pipelines import imaging
from ..providers import fal, replicate
from ..providers.openrouter import OpenRouterImageProvider, ProviderError
from ..redis_io import load_job, publish_progress
from ..storage import build_key, download_object, presign_get, sha256_hex, upload_bytes

log = logging.getLogger("aips.tasks.upscale")

TASK_NAME = "aips.upscale"

#: Above this dimension (px) the creative-enhance pass tiles the image instead of
#: sending it whole, so each model call stays within a sane resolution.
_ENHANCE_TILE = 1024
#: Overlap between tiles (px) so seams blend rather than show a hard join.
_ENHANCE_TILE_OVERLAP = 96


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


def _enhance_instruction(creativity: float) -> str:
    """Detail-enhance instruction; how much detail to invent scales with creativity."""
    if creativity >= 0.66:
        detail = (
            "add rich, realistic fine detail and texture, reconstructing plausible "
            "micro-structure where the upscale is soft"
        )
    elif creativity >= 0.33:
        detail = "add realistic fine detail and texture, and noticeably sharpen edges"
    else:
        detail = "subtly sharpen textures and edges and remove residual blur"
    return (
        f"Enhance this image: {detail}. Keep the composition, framing, subject "
        "shapes and colors IDENTICAL — do not move, add or remove objects, do not "
        "recolor, do not crop, rotate or resize. This is a detail/sharpness pass "
        "only."
    )


def _creative_enhance(
    base_png: bytes, creativity: float, seed: int | None, provider: OpenRouterImageProvider
) -> tuple[bytes, float | None, str | None]:
    """Run a Gemini img2img enhance pass over the base upscale.

    Tiles the image when either dimension exceeds `_ENHANCE_TILE` (with overlap so
    seams blend), enhances each tile, reassembles, then color-matches the whole
    result back to the base upscale to kill any global color drift. Returns
    (enhanced_png, cost_usd_or_None, model_or_None). On any provider failure the
    caller keeps the base upscale, so enhance is best-effort.
    """
    base = imaging.decode_rgba(base_png)
    instruction = _enhance_instruction(creativity)
    total_cost: float | None = None
    model: str | None = None

    def _accrue(result_cost: float | None, result_model: str | None) -> None:
        nonlocal total_cost, model
        if result_cost is not None:
            total_cost = (total_cost or 0.0) + result_cost
        if result_model:
            model = result_model

    if base.width <= _ENHANCE_TILE and base.height <= _ENHANCE_TILE:
        result = provider.image_edit(imaging.encode_png(base), instruction, seed=seed)
        _accrue(result.cost_usd, result.model)
        enhanced = imaging.resize_to(imaging.decode_rgba(result.png_bytes), base.size)
    else:
        enhanced = base.copy()
        step = _ENHANCE_TILE - _ENHANCE_TILE_OVERLAP
        for top in range(0, base.height, step):
            for left in range(0, base.width, step):
                right = min(left + _ENHANCE_TILE, base.width)
                bottom = min(top + _ENHANCE_TILE, base.height)
                box = (left, top, right, bottom)
                tile = base.crop(box)
                result = provider.image_edit(imaging.encode_png(tile), instruction, seed=seed)
                _accrue(result.cost_usd, result.model)
                enhanced_tile = imaging.resize_to(
                    imaging.decode_rgba(result.png_bytes), tile.size
                )
                enhanced.paste(enhanced_tile, (left, top))
                if right >= base.width:
                    break
            if bottom >= base.height:
                break

    # Color-match the enhanced result back to the base upscale over the WHOLE
    # frame (everything is "trusted" — we only wanted detail, not color change).
    trusted = Image.new("L", enhanced.size, 255)
    matched = imaging.color_match(enhanced, base, trusted)
    return imaging.encode_png(matched), total_cost, model


@app.task(name=TASK_NAME, bind=True)
def upscale(self, *, job_id: str, inputs: dict, user_id: str = "anon", idempotency_key=None):
    job: Job = load_job(job_id) or new_job(job_id, "upscale")  # type: ignore[arg-type]

    if job.get("status") == "succeeded":
        return {"jobId": job_id, "status": "succeeded"}

    inputs = inputs or {}
    image_ref = inputs.get("image") or {}
    scale = int(inputs.get("scale") or 2)
    creativity_raw = inputs.get("creativity")
    creativity = (
        0.0 if creativity_raw is None else float(max(0.0, min(1.0, float(creativity_raw))))
    )
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

    # Optional creative-enhance pass (Gemini img2img) on top of the base upscale.
    # Best-effort: a provider failure here keeps the (already good) base upscale.
    if creativity > 0.0:
        job["stage"] = "post_processing"
        job["progress"] = 0.9
        publish_progress(job)
        try:
            enhanced_png, enh_cost, enh_model = _creative_enhance(
                png, creativity, inputs.get("seed"), OpenRouterImageProvider()
            )
            png = enhanced_png
            img = Image.open(BytesIO(png)).convert("RGBA")
            if enh_cost is not None:
                job["costUsd"] = (job.get("costUsd") or 0.0) + enh_cost
            if enh_model:
                job["providerResolved"] = f"{provider_name}+{enh_model}"
        except ProviderError as exc:
            log.warning(
                "upscale creative-enhance failed job=%s code=%s: %s; keeping base upscale",
                job_id,
                exc.code,
                exc.message,
            )
        except Exception:  # noqa: BLE001
            log.exception(
                "upscale creative-enhance unexpected error job=%s; keeping base upscale",
                job_id,
            )

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
            "suggestedLayerName": (
                f"Upscaled {scale}x (enhanced)" if creativity > 0.0 else f"Upscaled {scale}x"
            ),
        },
    }
    job["artifacts"] = [artifact]
    job["status"] = "succeeded"
    job["stage"] = "done"
    job["progress"] = 1.0
    job["finishedAt"] = now_iso()
    publish_progress(job)

    return {"jobId": job_id, "status": "succeeded", "key": key}
