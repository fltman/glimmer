"""Bridge loop: Node API (Redis intake list) -> Celery tasks.

The Node API cannot call Celery directly, so it LPUSHes a `QueuedJobPayload`
(JSON) onto the Redis list `aips:jobs:incoming`. This long-running loop BRPOPs
each payload and dispatches it to the right Celery task on the right queue,
keyed by `capability`.

Run with the `aips-bridge` console script (see pyproject [project.scripts]).
"""

from __future__ import annotations

import logging
import signal
import sys

from .celery_app import CAPABILITY_TASKS, ECHO_TASK, app, queue_for
from .contracts import (
    QueuedJobPayload,
    job_store_key,  # noqa: F401  (documents the store key the API reads)
    new_job,
)
from .redis_io import get_client, pop_incoming, publish_progress, save_job
from .storage import ensure_bucket

log = logging.getLogger("aips.bridge")

_running = True


def _handle_signal(signum, _frame) -> None:
    global _running
    log.info("Received signal %s, shutting down bridge", signum)
    _running = False


def dispatch(payload: QueuedJobPayload) -> None:
    """Route one QueuedJobPayload to a Celery task by capability."""
    job_id = payload["jobId"]
    capability = payload["capability"]
    inputs = payload.get("inputs")
    user_id = payload["userId"]

    # If the API already wrote a Job record, keep it; otherwise seed a queued one
    # so a client polling `aips:job:<id>` sees state immediately.
    if get_client().exists(job_store_key(job_id)) == 0:
        save_job(new_job(job_id, capability))

    # The Phase 0 smoke test uses capability=="echo" (not a real capability) to
    # exercise the full pipe without a provider call.
    if capability == "echo":
        task_name, queue = ECHO_TASK, "fast"
    else:
        task_name = CAPABILITY_TASKS.get(capability)
        queue = queue_for(capability)

    if task_name is None:
        # No worker implements this capability yet — fail the job cleanly so the
        # client isn't left waiting forever.
        job = new_job(job_id, capability)
        job["status"] = "failed"
        job["stage"] = "done"
        job["error"] = {
            "code": "capability_not_implemented",
            "message": f"No worker task registered for capability '{capability}'",
        }
        from .contracts import now_iso

        job["finishedAt"] = now_iso()
        publish_progress(job)
        log.warning("No task for capability=%s job=%s", capability, job_id)
        return

    app.send_task(
        task_name,
        kwargs={
            "job_id": job_id,
            "inputs": inputs,
            "user_id": user_id,
            "idempotency_key": payload.get("idempotencyKey"),
        },
        queue=queue,
    )
    log.info("Dispatched job=%s capability=%s -> task=%s queue=%s",
             job_id, capability, task_name, queue)


def run() -> None:
    """Blocking dispatch loop. Exits on SIGINT/SIGTERM."""
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s %(levelname)s %(name)s %(message)s",
    )
    signal.signal(signal.SIGINT, _handle_signal)
    signal.signal(signal.SIGTERM, _handle_signal)

    ensure_bucket()
    log.info("aips-bridge started; consuming %s", "aips:jobs:incoming")

    while _running:
        try:
            payload = pop_incoming(timeout=5)
            if payload is None:
                continue
            dispatch(payload)
        except Exception:  # noqa: BLE001 — never let the loop die on one bad job
            log.exception("Error handling incoming job; continuing")

    log.info("aips-bridge stopped")


def main() -> None:
    run()
    sys.exit(0)


if __name__ == "__main__":
    main()
