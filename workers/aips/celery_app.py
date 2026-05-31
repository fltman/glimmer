"""Celery application: Redis broker + result backend, segregated queues.

Queues (mirrors the routing in the plan):
  - fast  : quick ops (segment, remove_background fallback, echo, color_match local grade)
  - gen   : generative model calls (text_to_image, image_edit, inpaint, outpaint, harmonize, relight, remove_reflections)
  - heavy : long-running pixel pipelines (upscale, incl. creative-enhance pass)

Tasks are registered by importing the `aips.tasks.*` modules below.
"""

from __future__ import annotations

from celery import Celery

from .config import settings
from .contracts import Capability

app = Celery(
    "aips",
    broker=settings.redis_url,
    backend=settings.redis_url,
    include=[
        "aips.tasks.echo",
        "aips.tasks.text_to_image",
        "aips.tasks.image_edit",
        "aips.tasks.inpaint",
        "aips.tasks.outpaint",
        "aips.tasks.upscale",
        "aips.tasks.segment",
        "aips.tasks.harmonize",
        "aips.tasks.relight",
        "aips.tasks.color_match",
        "aips.tasks.remove_reflections",
    ],
)

# Queue names.
QUEUE_FAST = "fast"
QUEUE_GEN = "gen"
QUEUE_HEAVY = "heavy"

#: Capability -> Celery task name. The bridge uses this to dispatch.
CAPABILITY_TASKS: dict[str, str] = {
    "text_to_image": "aips.text_to_image",
    # Phase 3 capabilities.
    "image_edit": "aips.image_edit",
    "inpaint": "aips.inpaint",
    "outpaint": "aips.outpaint",
    "upscale": "aips.upscale",
    "segment": "aips.segment",
    "harmonize": "aips.harmonize",
    "relight": "aips.relight",
    "color_match": "aips.color_match",
    "remove_reflections": "aips.remove_reflections",
    # remove_background runs client-side (ONNX) via a client_directive; no task.
}

#: Capability -> queue. Determines where the bridge routes a job.
CAPABILITY_QUEUES: dict[str, str] = {
    "text_to_image": QUEUE_GEN,
    "image_edit": QUEUE_GEN,
    "inpaint": QUEUE_GEN,
    "outpaint": QUEUE_GEN,
    "harmonize": QUEUE_GEN,
    # relight is a generative img2img call (like image_edit/harmonize) -> gen.
    "relight": QUEUE_GEN,
    # remove_reflections is a generative img2img edit (Gemini) -> gen.
    "remove_reflections": QUEUE_GEN,
    "segment": QUEUE_FAST,
    "remove_background": QUEUE_FAST,
    # color_match is a pure local numpy/Pillow op (no model) -> fast queue.
    "color_match": QUEUE_FAST,
    "upscale": QUEUE_HEAVY,
}

#: Special non-capability task used by the Phase 0 end-to-end smoke test.
ECHO_TASK = "aips.echo"


def queue_for(capability: Capability | str) -> str:
    """Pick the queue for a capability; default to `gen` for unknowns."""
    return CAPABILITY_QUEUES.get(str(capability), QUEUE_GEN)


app.conf.update(
    task_serializer="json",
    result_serializer="json",
    accept_content=["json"],
    timezone="UTC",
    enable_utc=True,
    task_track_started=True,
    task_acks_late=True,                 # redeliver if a worker dies mid-task
    worker_prefetch_multiplier=1,        # fair dispatch for long gen jobs
    broker_connection_retry_on_startup=True,
    result_expires=24 * 60 * 60,
)
