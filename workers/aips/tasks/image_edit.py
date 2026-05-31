"""image_edit Celery task — natural-language edit of an existing image.

Flow mirrors text_to_image: download the source image (by AssetRef.key),
call the provider's Gemini-style `image_edit(image, instruction)`, upload the
result PNG, attach an image artifact + cost. Queue: `gen`.

`inputs` is an ImageEditInputs dict: {image: AssetRef, instruction, seed?}.
"""

from __future__ import annotations

import logging

from ..celery_app import app
from ..contracts import Job, JobArtifact, new_job, now_iso
from ..providers.openrouter import OpenRouterImageProvider, ProviderError
from ..redis_io import load_job, publish_progress
from ..storage import build_key, download_object, presign_get, sha256_hex, upload_bytes

log = logging.getLogger("aips.tasks.image_edit")

TASK_NAME = "aips.image_edit"


def _fail(job: Job, code: str, message: str) -> None:
    job["status"] = "failed"
    job["stage"] = "done"
    job["progress"] = 1.0
    job["error"] = {"code": code, "message": message}
    job["finishedAt"] = now_iso()
    publish_progress(job)


@app.task(name=TASK_NAME, bind=True)
def image_edit(self, *, job_id: str, inputs: dict, user_id: str = "anon", idempotency_key=None):
    job: Job = load_job(job_id) or new_job(job_id, "image_edit")  # type: ignore[arg-type]

    # Idempotency: never re-run (and re-charge) an already-finished job on retry.
    if job.get("status") == "succeeded":
        return {"jobId": job_id, "status": "succeeded"}

    inputs = inputs or {}
    instruction = (inputs.get("instruction") or "").strip()
    image_ref = inputs.get("image") or {}
    key_in = image_ref.get("key")
    if not instruction:
        _fail(job, "invalid_inputs", "image_edit requires a non-empty 'instruction'")
        return {"jobId": job_id, "status": "failed"}
    if not key_in:
        _fail(job, "invalid_inputs", "image_edit requires inputs.image.key")
        return {"jobId": job_id, "status": "failed"}

    provider = OpenRouterImageProvider()
    job["providerResolved"] = provider.model

    # 1) download input
    job["status"] = "running"
    job["stage"] = "calling_model"
    job["progress"] = 0.15
    publish_progress(job)

    try:
        image_bytes = download_object(key_in)
    except Exception as exc:  # noqa: BLE001
        log.exception("image_edit download failed job=%s key=%s", job_id, key_in)
        _fail(job, "storage_error", f"Could not download input image: {exc}")
        return {"jobId": job_id, "status": "failed"}

    # 2) call model
    job["progress"] = 0.4
    publish_progress(job)
    try:
        result = provider.image_edit(image_bytes, instruction, seed=inputs.get("seed"))
    except ProviderError as exc:
        log.warning("image_edit provider error job=%s code=%s: %s", job_id, exc.code, exc.message)
        _fail(job, exc.code, exc.message)
        return {"jobId": job_id, "status": "failed"}
    except Exception as exc:  # noqa: BLE001
        log.exception("image_edit unexpected error job=%s", job_id)
        _fail(job, "internal_error", str(exc))
        return {"jobId": job_id, "status": "failed"}

    # 3) post-processing — store the artifact
    job["stage"] = "post_processing"
    job["progress"] = 0.8
    if result.cost_usd is not None:
        job["costUsd"] = result.cost_usd
    job["providerResolved"] = result.model
    publish_progress(job)

    digest = sha256_hex(result.png_bytes)
    key = build_key(user_id, digest, "png")
    try:
        upload_bytes(key, result.png_bytes, "image/png")
    except Exception as exc:  # noqa: BLE001
        log.exception("image_edit upload failed job=%s", job_id)
        _fail(job, "storage_error", f"Failed to store result: {exc}")
        return {"jobId": job_id, "status": "failed"}

    artifact: JobArtifact = {
        "kind": "image",
        "url": presign_get(key, expires_seconds=24 * 60 * 60),
        "contentType": "image/png",
        "width": result.width,
        "height": result.height,
        "placement": {
            "roi": {"x": 0, "y": 0, "width": result.width, "height": result.height},
            "suggestedLayerName": "Edited",
        },
    }
    job["artifacts"] = [artifact]
    job["status"] = "succeeded"
    job["stage"] = "done"
    job["progress"] = 1.0
    job["finishedAt"] = now_iso()
    publish_progress(job)

    return {"jobId": job_id, "status": "succeeded", "key": key}
