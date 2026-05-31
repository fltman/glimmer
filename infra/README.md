# infra — ai-ps backend stack (Docker Compose)

This directory runs everything **except** the web frontend: Postgres, Redis,
MinIO, the Fastify **api**, and the Python Celery **worker**. The React/Vite
web app runs on the host during development (faster HMR, no container rebuilds).

## Dev workflow

```
ai-ps/
  web/      → runs on the HOST via Vite  (pnpm --filter web dev → http://localhost:5173)
  api/      → in compose                 (http://localhost:8080)
  workers/  → in compose                 (Celery, no exposed port)
  infra/    → compose + service data (postgres / redis / minio)
```

So the everyday loop is:

```bash
# 1. one-time: create your env file from the template at the repo root
cp ../.env.example ../.env   # then fill in OPENROUTER_API_KEY etc.

# 2. start the backend stack (run from this infra/ directory)
docker compose up -d

# 3. run the web app on the host (from the repo root)
pnpm install
pnpm --filter web dev
```

The web app talks to the API at `VITE_API_URL` (default `http://localhost:8080`).
Provider keys (OpenRouter, fal, Replicate) are loaded from `../.env` into the
**api** and **worker** only — they are never bundled into the browser.

## Bringing it up / down

```bash
docker compose up -d            # start all services in the background
docker compose up -d --build    # rebuild api/worker images after code changes
docker compose ps               # see health/status
docker compose logs -f api      # tail one service (api | worker | postgres | redis | minio)
docker compose down             # stop everything (data is preserved under ./data)
docker compose down -v          # NOTE: -v removes named volumes; our data is in
                                #       bind mounts under ./data, so use `rm -rf data/`
                                #       to wipe instead.
```

The `minio-init` service is a one-shot job: it creates the bucket, makes it
private, and seeds a `models/` prefix for ONNX weights. It is idempotent, so it
is safe to re-run on every `up`.

## Ports

| Service        | Host port | Purpose                                   |
|----------------|-----------|-------------------------------------------|
| api (Fastify)  | `8080`    | REST + WebSocket relay (`API_PORT`)       |
| postgres       | `5432`    | App / job / billing tables                |
| redis          | `6379`    | Celery broker + job-progress pub/sub      |
| minio (S3 API) | `9000`    | Object storage — presigned PUT/GET        |
| minio console  | `9001`    | Web UI for browsing buckets               |
| web (Vite)     | `5173`    | Frontend — runs on the host, not compose  |

## MinIO console

Open <http://localhost:9001> and log in with `MINIO_ROOT_USER` /
`MINIO_ROOT_PASSWORD` from `../.env` (defaults: `aips` / `aips_dev_password`).
You'll find the `aips` bucket with a `models/` prefix after first startup.

The S3 API itself is at `http://localhost:9000`. Inside the compose network the
services reach MinIO at `minio:9000` (this is `MINIO_ENDPOINT`); presigned URLs
handed to the browser use `MINIO_PUBLIC_ENDPOINT` (`http://localhost:9000`).

## Where data lives

All persistent state is in bind mounts under `infra/data/` (gitignored):

```
infra/data/postgres/   # Postgres cluster (PGDATA)
infra/data/redis/      # Redis append-only file
infra/data/minio/      # MinIO objects
```

To completely reset local state, stop the stack and delete the directory:

```bash
docker compose down
rm -rf data/
```

## Service networking note

Services address each other by service name on the compose network — that's why
`../.env` uses `postgres`, `redis`, and `minio:9000` as hostnames:

- `DATABASE_URL=postgresql://…@postgres:5432/aips`
- `REDIS_URL=redis://redis:6379/0`
- `MINIO_ENDPOINT=minio:9000`

These hostnames only resolve **inside** compose. From the host (e.g. a `psql`
client) use `localhost` with the mapped ports above.
