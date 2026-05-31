"""inpaint Celery task — mask-aware regenerate/remove. Queue: `gen`.

Downloads the ROI image + mask, runs the inpaint pipeline (color-match + feather
+ composite), uploads the composited ROI PNG and returns an artifact whose
placement.roi tells the web client where to drop the new layer.

`inputs` is an InpaintInputs dict:
  {image: AssetRef, mask: AssetRef, prompt, mode: "fill"|"remove", roi: Rect, seed?}.
"""

from __future__ import annotations

import logging

from ..celery_app import app
from ..contracts import Job, JobArtifact, new_job, now_iso
from ..pipelines.inpaint import run_inpaint
from ..providers.openrouter import ProviderError
from ..redis_io import load_job, publish_progress
from ..storage import build_key, download_object, presign_get, sha256_hex, upload_bytes

log = logging.getLogger("aips.tasks.inpaint")

TASK_NAME = "aips.inpaint"


def _fail(job: Job, code: str, message: str) -> None:
    job["status"] = "failed"
    job["stage"] = "done"
    job["progress"] = 1.0
    job["error"] = {"code": code, "message": message}
    job["finishedAt"] = now_iso()
    publish_progress(job)


@app.task(name=TASK_NAME, bind=True)
def inpaint(self, *, job_id: str, inputs: dict, user_id: str = "anon", idempotency_key=None):
    job: Job = load_job(job_id) or new_job(job_id, "inpaint")  # type: ignore[arg-type]

    if job.get("status") == "succeeded":
        return {"jobId": job_id, "status": "succeeded"}

    inputs = inputs or {}
    image_ref = inputs.get("image") or {}
    mask_ref = inputs.get("mask") or {}
    reference_ref = inputs.get("referenceImage") or {}
    roi = inputs.get("roi") or {}
    mode = inputs.get("mode") or "fill"
    prompt = inputs.get("prompt") or ""

    if not image_ref.get("key") or not mask_ref.get("key"):
        _fail(job, "invalid_inputs", "inpaint requires inputs.image.key and inputs.mask.key")
        return {"jobId": job_id, "status": "failed"}
    if mode not in ("fill", "remove"):
        _fail(job, "invalid_inputs", f"inpaint mode must be 'fill' or 'remove', got {mode!r}")
        return {"jobId": job_id, "status": "failed"}
    has_reference = bool(reference_ref.get("key"))
    # A "fill" needs *something* to fill with: a text prompt or a reference image.
    if mode == "fill" and not prompt.strip() and not has_reference:
        _fail(
            job,
            "invalid_inputs",
            "inpaint mode 'fill' requires a non-empty 'prompt' or a 'referenceImage'",
        )
        return {"jobId": job_id, "status": "failed"}

    job["status"] = "running"
    job["stage"] = "calling_model"
    job["progress"] = 0.15
    publish_progress(job)

    # 1) download ROI image + mask (+ optional reference for generative fill)
    try:
        image_bytes = download_object(image_ref["key"])
        mask_bytes = download_object(mask_ref["key"])
        reference_bytes = (
            download_object(reference_ref["key"])
            if has_reference and mode == "fill"
            else None
        )
    except Exception as exc:  # noqa: BLE001
        log.exception("inpaint download failed job=%s", job_id)
        _fail(job, "storage_error", f"Could not download inputs: {exc}")
        return {"jobId": job_id, "status": "failed"}

    # 2) creative step + post-processing (color-match, feather, composite)
    job["progress"] = 0.4
    publish_progress(job)
    try:
        out = run_inpaint(
            image_bytes=image_bytes,
            mask_bytes=mask_bytes,
            prompt=prompt,
            mode=mode,
            roi=roi,
            seed=inputs.get("seed"),
            reference_bytes=reference_bytes,
        )
    except ProviderError as exc:
        log.warning("inpaint provider error job=%s code=%s: %s", job_id, exc.code, exc.message)
        _fail(job, exc.code, exc.message)
        return {"jobId": job_id, "status": "failed"}
    except Exception as exc:  # noqa: BLE001
        log.exception("inpaint unexpected error job=%s", job_id)
        _fail(job, "internal_error", str(exc))
        return {"jobId": job_id, "status": "failed"}

    # 3) store composited ROI
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
        log.exception("inpaint upload failed job=%s", job_id)
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
            "suggestedLayerName": (
                "Removed"
                if mode == "remove"
                else ("Reference fill" if has_reference else "Inpaint")
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
