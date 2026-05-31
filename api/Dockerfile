# ai-ps API — Fastify (Node 20). Pragmatic single-stage image for Compose.
#
# Build context is the monorepo root so the pnpm workspace (and the
# @aips/shared-types workspace dep) resolve. Runs the API via tsx (no separate
# TS build step needed for Phase 0; shared-types is consumed as source).
FROM node:20-slim

# pnpm via corepack
RUN corepack enable

WORKDIR /repo

# Workspace manifests first for better layer caching.
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml* turbo.json tsconfig.base.json ./
COPY packages/shared-types/package.json packages/shared-types/
COPY api/package.json api/

# Install only what the API subtree needs (plus its workspace deps).
RUN pnpm install --filter @aips/api...

# Now copy sources.
COPY packages/shared-types/ packages/shared-types/
COPY api/ api/

WORKDIR /repo/api

ENV NODE_ENV=production
EXPOSE 8080

# tsx runs the TS entrypoint directly; shared-types is imported as source.
CMD ["pnpm", "exec", "tsx", "src/server.ts"]
