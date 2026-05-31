"""remove_reflections Celery task — erase glare/reflections off glass, windows,
water, screens and eyeglasses while keeping what is behind the glass intact.
Queue: `gen`.

Downloads the source image, runs the remove-reflections pipeline (optional ROI
crop + context pad -> Gemini edit -> color-match -> feather blend-back), uploads
the result PNG and returns an artifact whose placement.roi tells the web client
where to drop the new layer (the roi when confined, else the whole image).

`inputs` is a RemoveReflectionsInputs dict:
  {image: AssetRef, roi?: Rect, strength?: float (0..1, default 0.7), seed?}.
"""

from __future__ import annotations

import logging

from ..celery_app import app
from ..contracts import Job, JobArtifact, new_job, now_iso
from ..pipelines.remove_reflections import run_remove_reflections
from ..providers.openrouter import ProviderError
from ..redis_io import load_job, publish_progress
from ..storage import build_key, download_object, presign_get, sha256_hex, upload_bytes

log = logging.getLogger("aips.tasks.remove_reflections")

TASK_NAME = "aips.remove_reflections"

#: Default suppression strength when none is supplied.
_DEFAULT_STRENGTH = 0.7


def _fail(job: Job, code: str, message: str) -> None:
    job["status"] = "failed"
    job["stage"] = "done"
    job["progress"] = 1.0
    job["error"] = {"code": code, "message": message}
    job["finishedAt"] = now_iso()
    publish_progress(job)


@app.task(name=TASK_NAME, bind=True)
def remove_reflections(
    self, *, job_id: str, inputs: dict, user_id: str = "anon", idempotency_key=None
):
    job: Job = load_job(job_id) or new_job(job_id, "remove_reflections")  # type: ignore[arg-type]

    # Idempotency: never re-run (and re-charge) an already-finished job on retry.
    if job.get("status") == "succeeded":
        return {"jobId": job_id, "status": "succeeded"}

    inputs = inputs or {}
    image_ref = inputs.get("image") or {}
    key_in = image_ref.get("key")
    roi = inputs.get("roi")  # optional; None -> whole image
    strength_raw = inputs.get("strength")
    strength = (
        _DEFAULT_STRENGTH
        if strength_raw is None
        else float(max(0.0, min(1.0, float(strength_raw))))
    )

    if not key_in:
        _fail(job, "invalid_inputs", "remove_reflections requires inputs.image.key")
        return {"jobId": job_id, "status": "failed"}

    job["status"] = "running"
    job["stage"] = "calling_model"
    job["progress"] = 0.15
    publish_progress(job)

    # 1) download input
    try:
        image_bytes = download_object(key_in)
    except Exception as exc:  # noqa: BLE001
        log.exception("remove_reflections download failed job=%s key=%s", job_id, key_in)
        _fail(job, "storage_error", f"Could not download input image: {exc}")
        return {"jobId": job_id, "status": "failed"}

    # 2) creative step + post-processing (color-match, feather, composite)
    job["progress"] = 0.4
    publish_progress(job)
    try:
        out = run_remove_reflections(
            image_bytes=image_bytes,
            roi=roi if isinstance(roi, dict) else None,
            strength=strength,
            seed=inputs.get("seed"),
        )
    except ProviderError as exc:
        log.warning(
            "remove_reflections provider error job=%s code=%s: %s",
            job_id,
            exc.code,
            exc.message,
        )
        _fail(job, exc.code, exc.message)
        return {"jobId": job_id, "status": "failed"}
    except Exception as exc:  # noqa: BLE001
        log.exception("remove_reflections unexpected error job=%s", job_id)
        _fail(job, "internal_error", str(exc))
        return {"jobId": job_id, "status": "failed"}

    # 3) store result
    job["stage"] = "post_processing"
    job["progress"] = 0.85
    if out.cost_usd is not None:
        job["costUsd"] = out.cost_usd
    job["providerResolved"] = out.model
    publish_progress(job)

    digest = sha256_hex(out.png_bytes)
    key = build_key(user_id, digest, "png")
    try:
        upload_bytes(key, out.png_bytes, "image/png")
    except Exception as exc:  # noqa: BLE001
        log.exception("remove_reflections upload failed job=%s", job_id)
        _fail(job, "storage_error", f"Failed to store result: {exc}")
        return {"jobId": job_id, "status": "failed"}

    artifact: JobArtifact = {
        "kind": "image",
        "url": presign_get(key, expires_seconds=24 * 60 * 60),
        "contentType": "image/png",
        "width": out.width,
        "height": out.height,
        "placement": {
            "roi": out.placement_roi,
            "suggestedLayerName": "Reflections removed",
        },
    }
    job["artifacts"] = [artifact]
    job["status"] = "succeeded"
    job["stage"] = "done"
    job["progress"] = 1.0
    job["finishedAt"] = now_iso()
    publish_progress(job)

    return {"jobId": job_id, "status": "succeeded", "key": key}
