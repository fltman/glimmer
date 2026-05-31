"""Echo task — Phase 0 end-to-end smoke test.

Proves the full pipe: Browser -> API -> Redis intake -> bridge -> Celery -> MinIO
-> Redis pub/sub -> API WS. It advances a Job through running -> post_processing
-> succeeded, publishing progress at each step, and produces a real (tiny) PNG
artifact stored in MinIO so the API can presign a GET URL.
"""

from __future__ import annotations

import time
from io import BytesIO

from PIL import Image

from ..celery_app import ECHO_TASK, app
from ..contracts import Job, JobArtifact, new_job, now_iso
from ..redis_io import load_job, publish_progress
from ..storage import build_key, presign_get, sha256_hex, upload_bytes


def _tiny_png() -> bytes:
    """A 64x64 solid-teal PNG — a trivial but real artifact."""
    img = Image.new("RGBA", (64, 64), (13, 148, 136, 255))  # tailwind teal-600
    buf = BytesIO()
    img.save(buf, format="PNG")
    return buf.getvalue()


@app.task(name=ECHO_TASK, bind=True)
def echo(self, *, job_id: str, inputs=None, user_id: str = "anon", idempotency_key=None):
    """Run the echo job, publishing progress throughout."""
    job: Job = load_job(job_id) or new_job(job_id, "echo")  # type: ignore[arg-type]
    job["providerResolved"] = "echo"

    # 1) running / calling_model (simulated work)
    job["status"] = "running"
    job["stage"] = "calling_model"
    job["progress"] = 0.25
    publish_progress(job)
    time.sleep(0.5)

    # 2) post_processing — produce and store the artifact
    job["stage"] = "post_processing"
    job["progress"] = 0.6
    publish_progress(job)

    png = _tiny_png()
    digest = sha256_hex(png)
    key = build_key(user_id, digest, "png")
    upload_bytes(key, png, "image/png")
    time.sleep(0.5)

    # 3) succeeded — attach artifact. Phase 0: use a public-endpoint URL.
    # Private bucket -> hand back a presigned GET (public-host) the browser can fetch.
    artifact: JobArtifact = {
        "kind": "image",
        "url": presign_get(key, expires_seconds=24 * 60 * 60),
        "contentType": "image/png",
        "width": 64,
        "height": 64,
        "placement": {
            "roi": {"x": 0, "y": 0, "width": 64, "height": 64},
            "suggestedLayerName": "Echo",
        },
    }
    job["artifacts"] = [artifact]
    job["status"] = "succeeded"
    job["stage"] = "done"
    job["progress"] = 1.0
    job["costUsd"] = 0.0
    job["finishedAt"] = now_iso()
    publish_progress(job)
    return {"jobId": job_id, "key": key}
