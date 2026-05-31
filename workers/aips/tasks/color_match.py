"""color_match Celery task — transfer a reference image's color grade. Queue: `fast`.

A PURE numpy/Pillow operation (NO model call): Reinhard-style mean/std color
transfer in CIE L*a*b* from the reference onto the active image, blended by
`strength` (0 = original, 1 = full transfer). The image's alpha is preserved.
Because there is no provider call, this is cheap + fast and needs no OpenRouter
key — `providerResolved` is reported as "local-numpy".

`inputs` is a ColorMatchInputs dict: {image: AssetRef, reference: AssetRef, strength?}.
"""

from __future__ import annotations

import logging

from ..celery_app import app
from ..contracts import Job, JobArtifact, new_job, now_iso
from ..pipelines import imaging
from ..redis_io import load_job, publish_progress
from ..storage import build_key, download_object, presign_get, sha256_hex, upload_bytes

log = logging.getLogger("aips.tasks.color_match")

TASK_NAME = "aips.color_match"

#: Reported provider for a purely-local op (no OpenRouter key needed).
_PROVIDER = "local-numpy"


def _fail(job: Job, code: str, message: str) -> None:
    job["status"] = "failed"
    job["stage"] = "done"
    job["progress"] = 1.0
    job["error"] = {"code": code, "message": message}
    job["finishedAt"] = now_iso()
    publish_progress(job)


@app.task(name=TASK_NAME, bind=True)
def color_match(self, *, job_id: str, inputs: dict, user_id: str = "anon", idempotency_key=None):
    job: Job = load_job(job_id) or new_job(job_id, "color_match")  # type: ignore[arg-type]

    # Idempotency: never re-run an already-finished job on retry.
    if job.get("status") == "succeeded":
        return {"jobId": job_id, "status": "succeeded"}

    inputs = inputs or {}
    image_ref = inputs.get("image") or {}
    reference_ref = inputs.get("reference") or {}
    key_in = image_ref.get("key")
    ref_key = reference_ref.get("key")
    strength_raw = inputs.get("strength")
    strength = (
        1.0 if strength_raw is None else float(max(0.0, min(1.0, float(strength_raw))))
    )

    if not key_in:
        _fail(job, "invalid_inputs", "color_match requires inputs.image.key")
        return {"jobId": job_id, "status": "failed"}
    if not ref_key:
        _fail(job, "invalid_inputs", "color_match requires inputs.reference.key")
        return {"jobId": job_id, "status": "failed"}

    # Local op — no provider call.
    job["providerResolved"] = _PROVIDER
    job["status"] = "running"
    job["stage"] = "calling_model"
    job["progress"] = 0.15
    publish_progress(job)

    # 1) download image + reference
    try:
        image_bytes = download_object(key_in)
        reference_bytes = download_object(ref_key)
    except Exception as exc:  # noqa: BLE001
        log.exception("color_match download failed job=%s", job_id)
        _fail(job, "storage_error", f"Could not download inputs: {exc}")
        return {"jobId": job_id, "status": "failed"}

    # 2) local color-grade transfer (Reinhard in CIE Lab), blended by strength.
    job["stage"] = "post_processing"
    job["progress"] = 0.5
    publish_progress(job)
    try:
        image = imaging.decode_rgba(image_bytes)
        reference = imaging.decode_rgba(reference_bytes)
        out = imaging.lab_color_transfer(image, reference, strength=strength)
        png = imaging.encode_png(out)
    except Exception as exc:  # noqa: BLE001
        log.exception("color_match transfer failed job=%s", job_id)
        _fail(job, "internal_error", f"Color transfer failed: {exc}")
        return {"jobId": job_id, "status": "failed"}

    # 3) store result
    job["progress"] = 0.85
    publish_progress(job)
    digest = sha256_hex(png)
    key = build_key(user_id, digest, "png")
    try:
        upload_bytes(key, png, "image/png")
    except Exception as exc:  # noqa: BLE001
        log.exception("color_match upload failed job=%s", job_id)
        _fail(job, "storage_error", f"Failed to store result: {exc}")
        return {"jobId": job_id, "status": "failed"}

    artifact: JobArtifact = {
        "kind": "image",
        "url": presign_get(key, expires_seconds=24 * 60 * 60),
        "contentType": "image/png",
        "width": out.width,
        "height": out.height,
        "placement": {
            "roi": {"x": 0, "y": 0, "width": out.width, "height": out.height},
            "suggestedLayerName": "Color matched",
        },
    }
    job["artifacts"] = [artifact]
    job["status"] = "succeeded"
    job["stage"] = "done"
    job["progress"] = 1.0
    job["finishedAt"] = now_iso()
    publish_progress(job)

    return {"jobId": job_id, "status": "succeeded", "key": key}
