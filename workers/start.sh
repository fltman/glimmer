#!/usr/bin/env bash
# Run BOTH the bridge loop and the Celery worker in one container.
#
# The bridge BRPOPs from the API intake list and dispatches Celery tasks; the
# worker executes them. They are independent processes sharing the same Redis.
# We background the bridge and run the worker in the foreground (PID 1-ish) so
# the container exits if the worker dies, and we propagate signals to both.
set -euo pipefail

# Forward SIGTERM/SIGINT to children so `docker stop` shuts down cleanly.
pids=()
term() {
  echo "[start.sh] shutting down..."
  for pid in "${pids[@]}"; do
    kill -TERM "$pid" 2>/dev/null || true
  done
  wait || true
  exit 0
}
trap term SIGTERM SIGINT

echo "[start.sh] starting aips-bridge..."
aips-bridge &
pids+=("$!")

echo "[start.sh] starting aips-worker..."
aips-worker "$@" &
pids+=("$!")

# Exit as soon as either process exits, then tear down the other.
wait -n
echo "[start.sh] a child exited; tearing down"
term
