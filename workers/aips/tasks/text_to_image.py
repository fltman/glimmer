"""text_to_image Celery task — proves orchestration + cost accounting.

Flow:
  running/calling_model -> OpenRouter generate -> upload PNG to MinIO
  -> post_processing -> succeeded (artifact + costUsd), publishing progress.
On any failure the job is marked failed with a stable error.code/message.

`inputs` is a TextToImageInputs dict from the shared-types contract:
  {prompt, negativePrompt?, width?, height?, seed?}
"""

from __future__ import annotations

import logging

from ..celery_app import app
from ..contracts import Job, JobArtifact, new_job, now_iso
from ..providers.openrouter import OpenRouterImageProvider, ProviderError
from ..redis_io import load_job, publish_progress
from ..storage import build_key, presign_get, sha256_hex, upload_bytes

log = logging.getLogger("aips.tasks.text_to_image")

TASK_NAME = "aips.text_to_image"


def _fail(job: Job, code: str, message: str) -> None:
    job["status"] = "failed"
    job["stage"] = "done"
    job["progress"] = 1.0
    job["error"] = {"code": code, "message": message}
    job["finishedAt"] = now_iso()
    publish_progress(job)


@app.task(name=TASK_NAME, bind=True)
def text_to_image(self, *, job_id: str, inputs: dict, user_id: str = "anon", idempotency_key=None):
    job: Job = load_job(job_id) or new_job(job_id, "text_to_image")  # type: ignore[arg-type]

    inputs = inputs or {}
    prompt = (inputs.get("prompt") or "").strip()
    if not prompt:
        _fail(job, "invalid_inputs", "text_to_image requires a non-empty 'prompt'")
        return {"jobId": job_id, "status": "failed"}

    provider = OpenRouterImageProvider()
    job["providerResolved"] = provider.model

    # 1) calling model
    job["status"] = "running"
    job["stage"] = "calling_model"
    job["progress"] = 0.2
    publish_progress(job)

    try:
        result = provider.text_to_image(
            prompt,
            negative_prompt=inputs.get("negativePrompt"),
            width=inputs.get("width"),
            height=inputs.get("height"),
            seed=inputs.get("seed"),
        )
    except ProviderError as exc:
        log.warning("text_to_image provider error job=%s code=%s: %s", job_id, exc.code, exc.message)
        _fail(job, exc.code, exc.message)
        return {"jobId": job_id, "status": "failed"}
    except Exception as exc:  # noqa: BLE001
        log.exception("text_to_image unexpected error job=%s", job_id)
        _fail(job, "internal_error", str(exc))
        return {"jobId": job_id, "status": "failed"}

    # 2) post-processing — store the artifact
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
        log.exception("text_to_image upload failed job=%s", job_id)
        _fail(job, "storage_error", f"Failed to store result: {exc}")
        return {"jobId": job_id, "status": "failed"}

    # 3) succeeded
    # Bucket is private (minio-init sets anonymous=none), so hand the browser a
    # presigned GET (host rewritten to MINIO_PUBLIC_ENDPOINT) rather than a bare
    # public URL it could not fetch. 24h matches the job-store TTL.
    artifact: JobArtifact = {
        "kind": "image",
        "url": presign_get(key, expires_seconds=24 * 60 * 60),
        "contentType": "image/png",
        "width": result.width,
        "height": result.height,
        "placement": {
            "roi": {"x": 0, "y": 0, "width": result.width, "height": result.height},
            "suggestedLayerName": "Generated",
        },
    }
    job["artifacts"] = [artifact]
    job["status"] = "succeeded"
    job["stage"] = "done"
    job["progress"] = 1.0
    job["finishedAt"] = now_iso()
    publish_progress(job)

    return {"jobId": job_id, "status": "succeeded", "key": key}
