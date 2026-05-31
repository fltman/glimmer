"""Celery worker entrypoint (`aips-worker` console script).

Boots a worker consuming all three queues (fast, gen, heavy). For production you
may split these into separate processes with different concurrency; for Phase 0
a single process consuming all queues is simplest.
"""

from __future__ import annotations

import sys

from .celery_app import QUEUE_FAST, QUEUE_GEN, QUEUE_HEAVY, app
from .storage import ensure_bucket

# Importing the tasks package registers every @app.task.
from . import tasks  # noqa: F401,E402


def main() -> None:
    # Make sure the artifact bucket exists before we start taking work.
    ensure_bucket()
    argv = [
        "worker",
        "--loglevel=INFO",
        f"--queues={QUEUE_FAST},{QUEUE_GEN},{QUEUE_HEAVY}",
        # Allow extra args passed after the script name (e.g. --concurrency=2).
        *sys.argv[1:],
    ]
    app.worker_main(argv=argv)


if __name__ == "__main__":
    main()
