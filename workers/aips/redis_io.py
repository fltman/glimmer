"""Redis I/O: client, job store, progress pub/sub, and the intake bridge primitive.

The canonical Job state is written to `aips:job:<id>` as JSON (the API reads it
for `GET /ai/jobs/:id` re-sync), and every state change is also published to the
`job:<id>` pub/sub channel as a `job_update` ServerWsMessage (the API relays it
over WebSocket).
"""

from __future__ import annotations

import json
from functools import lru_cache
from typing import Any

import redis

from .config import settings
from .contracts import (
    INCOMING_JOBS_LIST,
    Job,
    QueuedJobPayload,
    job_channel,
    job_store_key,
    server_ws_job_update,
)

# Job records persist long enough for the client to re-sync after disconnects.
JOB_TTL_SECONDS = 24 * 60 * 60


@lru_cache(maxsize=1)
def get_client() -> redis.Redis:
    """Process-wide Redis client (decoded to str)."""
    return redis.Redis.from_url(settings.redis_url, decode_responses=True)


def save_job(job: Job) -> None:
    """Persist the canonical Job JSON under `aips:job:<id>` (with a TTL).

    The store key is a Redis HASH with a `json` field (and a `userId` field the
    API writes at create-time for ownership checks). We only set/refresh `json`
    here so an existing API-written `userId` is preserved, then refresh the TTL.
    Layout MUST match api/src/jobs/store.ts (hgetall { json, userId }).
    """
    client = get_client()
    key = job_store_key(job["id"])
    client.hset(key, "json", json.dumps(job))
    client.expire(key, JOB_TTL_SECONDS)


def load_job(job_id: str) -> Job | None:
    """Read the canonical Job JSON from the hash `json` field, or None."""
    raw = get_client().hget(job_store_key(job_id), "json")
    return json.loads(raw) if raw else None


def publish_progress(job: Job) -> None:
    """Persist the job, then publish a `job_update` to `job:<id>`.

    Save-before-publish guarantees a client that subscribes and then immediately
    re-syncs via the store never sees a stale state.
    """
    save_job(job)
    msg = server_ws_job_update(job)
    get_client().publish(job_channel(job["id"]), json.dumps(msg))


def pop_incoming(timeout: int = 5) -> QueuedJobPayload | None:
    """Blocking BRPOP from the API intake list. Returns None on timeout.

    The API LPUSHes onto the head; we BRPOP the tail for FIFO ordering.
    """
    result = get_client().brpop([INCOMING_JOBS_LIST], timeout=timeout)
    if result is None:
        return None
    _list_name, raw = result
    payload: dict[str, Any] = json.loads(raw)
    return payload  # type: ignore[return-value]
