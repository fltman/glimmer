# ai-ps — AI-first image editor for the web

A modern, generative Photoshop alternative: a real layer-based, non-destructive raster
editor (custom WebGL2 compositor) whose primary superpower is AI — generative fill,
text-to-image, background removal, outpaint and upscale — built on **OpenRouter**.

> Architecture & roadmap: see the approved plan in `~/.claude/plans/` and the inline
> docs in each package. This repo is built in phases; Phase 0 (rails) + Phase 1
> (vertical slice) come first.

## Stack

| Layer    | Tech |
|----------|------|
| Web      | React + TypeScript + Vite + Tailwind, custom WebGL2 engine |
| API      | Node + TypeScript (Fastify), zod, Redis, Postgres, WebSocket |
| Workers  | Python + Celery (Pillow/numpy/OpenCV), OpenRouter / fal / Replicate |
| Storage  | Postgres (metadata), Redis (queue + pubsub), MinIO (blobs) |
| Infra    | Docker Compose (self-host), deployable to a single VPS |

## Monorepo layout

```
web/                React app + WebGL2 editor engine
api/                Fastify API: job intake, routing, key proxy, WS relay, presigned URLs
workers/            Celery workers: provider executors + AI pipelines
packages/shared-types   Shared TS contracts (capabilities, job DTOs)
infra/              docker-compose.yml + ops
```

## Quick start (dev)

```bash
cp .env.example .env          # fill in OPENROUTER_API_KEY
pnpm install                  # install TS workspaces
pnpm infra:up                 # postgres + redis + minio (+ api + worker in containers)
pnpm --filter web dev         # Vite dev server on http://localhost:5173
```

The web app talks only to the API. Provider keys never reach the browser.

## Principles

- **Linear-light, premultiplied-alpha compositing** in `RGBA16F`; sRGB only at present.
- **React never touches pixels** — the engine is an imperative TS class that owns the canvas.
- **Keys never reach the browser** — all model calls are proxied by the API/workers.
- **Tiles are the unit of everything** (rendering, memory, undo, AI region transfer).
