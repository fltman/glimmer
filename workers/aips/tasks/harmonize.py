"""harmonize Celery task — relight/color-grade an inserted subject. Queue: `gen`.

Downloads the foreground cutout (RGBA) + the background composite, runs the
harmonize pipeline (composite -> Gemini relight/grade -> identity-preserving
re-key through the original alpha), uploads the harmonized RGBA subject PNG and
returns an artifact whose placement.roi tells the web client where to overlay /
replace the foreground layer.

`inputs` is a HarmonizeInputs dict:
  {foreground: AssetRef, background: AssetRef, roi?: Rect, strength?: number, seed?}.
"""

from __future__ import annotations

import logging

from ..celery_app import app
from ..contracts import Job, JobArtifact, new_job, now_iso
from ..pipelines.harmonize import run_harmonize
from ..providers.openrouter import ProviderError
from ..redis_io import load_job, publish_progress
from ..storage import build_key, download_object, presign_get, sha256_hex, upload_bytes

log = logging.getLogger("aips.tasks.harmonize")

TASK_NAME = "aips.harmonize"


def _fail(job: Job, code: str, message: str) -> None:
    job["status"] = "failed"
    job["stage"] = "done"
    job["progress"] = 1.0
    job["error"] = {"code": code, "message": message}
    job["finishedAt"] = now_iso()
    publish_progress(job)


@app.task(name=TASK_NAME, bind=True)
def harmonize(self, *, job_id: str, inputs: dict, user_id: str = "anon", idempotency_key=None):
    job: Job = load_job(job_id) or new_job(job_id, "harmonize")  # type: ignore[arg-type]

    if job.get("status") == "succeeded":
        return {"jobId": job_id, "status": "succeeded"}

    inputs = inputs or {}
    fg_ref = inputs.get("foreground") or {}
    bg_ref = inputs.get("background") or {}
    roi = inputs.get("roi") or None
    strength = inputs.get("strength")

    if not fg_ref.get("key") or not bg_ref.get("key"):
        _fail(
            job,
            "invalid_inputs",
            "harmonize requires inputs.foreground.key and inputs.background.key",
        )
        return {"jobId": job_id, "status": "failed"}

    job["status"] = "running"
    job["stage"] = "calling_model"
    job["progress"] = 0.15
    publish_progress(job)

    # 1) download foreground cutout + background composite
    try:
        fg_bytes = download_object(fg_ref["key"])
        bg_bytes = download_object(bg_ref["key"])
    except Exception as exc:  # noqa: BLE001
        log.exception("harmonize download failed job=%s", job_id)
        _fail(job, "storage_error", f"Could not download inputs: {exc}")
        return {"jobId": job_id, "status": "failed"}

    # 2) creative step + post-processing (composite, relight, re-key)
    job["progress"] = 0.4
    publish_progress(job)
    try:
        out = run_harmonize(
            foreground_bytes=fg_bytes,
            background_bytes=bg_bytes,
            roi=roi,
            strength=strength,
            seed=inputs.get("seed"),
        )
    except ProviderError as exc:
        log.warning("harmonize provider error job=%s code=%s: %s", job_id, exc.code, exc.message)
        _fail(job, exc.code, exc.message)
        return {"jobId": job_id, "status": "failed"}
    except Exception as exc:  # noqa: BLE001
        log.exception("harmonize unexpected error job=%s", job_id)
        _fail(job, "internal_error", str(exc))
        return {"jobId": job_id, "status": "failed"}

    # 3) store harmonized subject layer
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
        log.exception("harmonize upload failed job=%s", job_id)
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
            "suggestedLayerName": "Harmonized",
        },
    }
    job["artifacts"] = [artifact]
    job["status"] = "succeeded"
    job["stage"] = "done"
    job["progress"] = 1.0
    job["finishedAt"] = now_iso()
    publish_progress(job)

    return {"jobId": job_id, "status": "succeeded", "key": key}
