"""Python mirror of @aips/shared-types (packages/shared-types/src/index.ts).

Keep these literals/shapes in sync with the TS contract. The worker produces the
canonical `Job` object as a plain dict and writes it (as JSON) both to the Redis
job store and to the per-job pub/sub channel inside a `job_update` ServerWsMessage.

Redis key / channel conventions (shared with the Node API):
  - Intake list   : aips:jobs:incoming   (API LPUSHes, bridge BRPOPs)
  - Job store key : aips:job:<jobId>     (full Job object as JSON)
  - Progress chan : job:<jobId>          (ServerWsMessage JSON: {type:"job_update", job})
"""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Any, Literal, TypedDict

# ──────────────────────────────────────────────────────────────
# Capabilities (mirror CAPABILITIES)
# ──────────────────────────────────────────────────────────────

CAPABILITIES: tuple[str, ...] = (
    "text_to_image",
    "image_edit",
    "inpaint",
    "outpaint",
    "segment",
    "upscale",
    "remove_background",
)

Capability = Literal[
    "text_to_image",
    "image_edit",
    "inpaint",
    "outpaint",
    "segment",
    "upscale",
    "remove_background",
]

ExecutionLocation = Literal["server", "client"]

# ──────────────────────────────────────────────────────────────
# Job status / stages (mirror JobStatus, JobProgressStage)
# ──────────────────────────────────────────────────────────────

JobStatus = Literal["queued", "running", "succeeded", "failed", "canceled"]

JobProgressStage = Literal[
    "queued",
    "uploading_input",
    "calling_model",
    "post_processing",
    "done",
]

# ──────────────────────────────────────────────────────────────
# Redis key / channel helpers (shared with the Node API)
# ──────────────────────────────────────────────────────────────

#: Redis list the API LPUSHes QueuedJobPayload JSON onto; the bridge BRPOPs it.
INCOMING_JOBS_LIST = "aips:jobs:incoming"


def job_channel(job_id: str) -> str:
    """Mirror of `jobChannel()` in shared-types: `job:<jobId>`."""
    return f"job:{job_id}"


def job_store_key(job_id: str) -> str:
    """Redis key the API reads the canonical Job JSON from: `aips:job:<id>`."""
    return f"aips:job:{job_id}"


# ──────────────────────────────────────────────────────────────
# Typed shapes (mirror the TS interfaces) — used as dict schemas
# ──────────────────────────────────────────────────────────────


class Rect(TypedDict):
    x: int
    y: int
    width: int
    height: int


class Placement(TypedDict, total=False):
    roi: Rect
    suggestedLayerName: str


class JobArtifact(TypedDict, total=False):
    kind: Literal["image", "mask", "preview"]
    url: str
    contentType: str
    width: int
    height: int
    placement: Placement


class JobError(TypedDict):
    code: str
    message: str


class Job(TypedDict, total=False):
    id: str
    capability: Capability
    status: JobStatus
    progress: float  # 0..1
    stage: JobProgressStage
    providerResolved: str
    artifacts: list[JobArtifact]
    costUsd: float
    error: JobError
    createdAt: str  # ISO 8601
    finishedAt: str


class QueuedJobPayload(TypedDict):
    jobId: str
    capability: Capability
    inputs: Any  # CapabilityInputsMap[C] validated at the API boundary
    userId: str
    idempotencyKey: str


# ──────────────────────────────────────────────────────────────
# Builders
# ──────────────────────────────────────────────────────────────


def now_iso() -> str:
    """ISO-8601 timestamp in UTC, matching the API's createdAt/finishedAt format."""
    return datetime.now(timezone.utc).isoformat()


def new_job(job_id: str, capability: str) -> Job:
    """A freshly-queued Job, ready to be advanced by a task."""
    return Job(
        id=job_id,
        capability=capability,  # type: ignore[typeddict-item]
        status="queued",
        progress=0.0,
        stage="queued",
        artifacts=[],
        createdAt=now_iso(),
    )


def server_ws_job_update(job: Job) -> dict[str, Any]:
    """Wrap a Job in a `job_update` ServerWsMessage for the pub/sub channel."""
    return {"type": "job_update", "job": job}
