"""outpaint Celery task — extend the canvas. Queue: `gen`.

Downloads the source image, runs the outpaint pipeline (inset + extend +
color-match + seam feather), uploads the full expanded PNG and returns an
artifact placed so the original content stays put (offset by left/top expansion).

`inputs` is an OutpaintInputs dict:
  {image: AssetRef, expand: {top,right,bottom,left}, prompt?, seed?}.

Followup: for large expansions, iterative single-side passes beat one pass —
extend one edge, re-feed, repeat — so the model always has real adjacent context.
"""

from __future__ import annotations

import logging

from ..celery_app import app
from ..contracts import Job, JobArtifact, new_job, now_iso
from ..pipelines.outpaint import run_outpaint
from ..providers.openrouter import ProviderError
from ..redis_io import load_job, publish_progress
from ..storage import build_key, download_object, presign_get, sha256_hex, upload_bytes

log = logging.getLogger("aips.tasks.outpaint")

TASK_NAME = "aips.outpaint"


def _fail(job: Job, code: str, message: str) -> None:
    job["status"] = "failed"
    job["stage"] = "done"
    job["progress"] = 1.0
    job["error"] = {"code": code, "message": message}
    job["finishedAt"] = now_iso()
    publish_progress(job)


@app.task(name=TASK_NAME, bind=True)
def outpaint(self, *, job_id: str, inputs: dict, user_id: str = "anon", idempotency_key=None):
    job: Job = load_job(job_id) or new_job(job_id, "outpaint")  # type: ignore[arg-type]

    if job.get("status") == "succeeded":
        return {"jobId": job_id, "status": "succeeded"}

    inputs = inputs or {}
    image_ref = inputs.get("image") or {}
    expand = inputs.get("expand") or {}

    if not image_ref.get("key"):
        _fail(job, "invalid_inputs", "outpaint requires inputs.image.key")
        return {"jobId": job_id, "status": "failed"}
    total_expand = sum(max(0, int(expand.get(s, 0))) for s in ("top", "right", "bottom", "left"))
    if total_expand <= 0:
        _fail(job, "invalid_inputs", "outpaint requires a positive expansion on at least one side")
        return {"jobId": job_id, "status": "failed"}

    job["status"] = "running"
    job["stage"] = "calling_model"
    job["progress"] = 0.15
    publish_progress(job)

    try:
        image_bytes = download_object(image_ref["key"])
    except Exception as exc:  # noqa: BLE001
        log.exception("outpaint download failed job=%s", job_id)
        _fail(job, "storage_error", f"Could not download input image: {exc}")
        return {"jobId": job_id, "status": "failed"}

    job["progress"] = 0.4
    publish_progress(job)
    try:
        out = run_outpaint(
            image_bytes=image_bytes,
            expand=expand,
            prompt=inputs.get("prompt"),
            seed=inputs.get("seed"),
        )
    except ProviderError as exc:
        log.warning("outpaint provider error job=%s code=%s: %s", job_id, exc.code, exc.message)
        _fail(job, exc.code, exc.message)
        return {"jobId": job_id, "status": "failed"}
    except Exception as exc:  # noqa: BLE001
        log.exception("outpaint unexpected error job=%s", job_id)
        _fail(job, "internal_error", str(exc))
        return {"jobId": job_id, "status": "failed"}

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
        log.exception("outpaint upload failed job=%s", job_id)
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
            "suggestedLayerName": "Outpaint",
        },
    }
    job["artifacts"] = [artifact]
    job["status"] = "succeeded"
    job["stage"] = "done"
    job["progress"] = 1.0
    job["finishedAt"] = now_iso()
    publish_progress(job)

    return {"jobId": job_id, "status": "succeeded", "key": key}
