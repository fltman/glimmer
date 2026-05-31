/**
 * Job intake routes.
 *
 *   POST /ai/jobs      — create (or dedup) a job, or return a client directive.
 *   GET  /ai/jobs/:id  — fetch a job for polling / re-sync.
 *
 * API ↔ worker bridge: a queued job's `QueuedJobPayload` is LPUSHed onto the
 * Redis list `aips:jobs:incoming`. The Python worker BRPOPs that list and
 * dispatches to the appropriate Celery task. Progress flows back over the
 * Redis pub/sub channel `job:<id>` (see ws.ts).
 */
import type { FastifyPluginAsync } from "fastify";
import { nanoid } from "nanoid";
import type {
  CreateJobResponse,
  QueuedJobPayload,
} from "@aips/shared-types";
import { getUserId } from "../auth.js";
import { redis, JOBS_INCOMING_LIST } from "../redis.js";
import { presignGet } from "../storage.js";
import {
  createJob,
  findByIdempotencyKey,
  getJob,
} from "./store.js";
import { CreateJobRequestSchema, JobIdParamsSchema } from "./schema.js";

/** Storage key of the client-side RMBG ONNX weights. */
const RMBG_WEIGHTS_KEY = "models/RMBG-1.4.onnx";

export const jobRoutes: FastifyPluginAsync = async (app) => {
  app.post("/ai/jobs", async (request, reply) => {
    const parsed = CreateJobRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply
        .code(400)
        .send({ error: "invalid_request", issues: parsed.error.issues });
    }
    const body = parsed.data;
    const userId = getUserId(request);

    // --- Client-preferred path: RMBG background removal runs in-browser. ---
    // When the client prefers (and is capable of) local execution, we hand
    // back a directive with a presigned weights URL instead of enqueuing —
    // zero provider cost, no server round-trip for pixels.
    if (
      body.capability === "remove_background" &&
      body.preferLocation === "client"
    ) {
      const weightsUrl = await presignGet(RMBG_WEIGHTS_KEY);
      const directive: CreateJobResponse = {
        kind: "client_directive",
        capability: "remove_background",
        model: "RMBG-1.4",
        weightsUrl,
      };
      return reply.send(directive);
    }

    // --- Idempotency: re-posting the same key returns the existing job. ---
    const existing = await findByIdempotencyKey(userId, body.idempotencyKey);
    if (existing) {
      const response: CreateJobResponse = { kind: "job", job: existing };
      return reply.send(response);
    }

    // --- Create + enqueue a server job. ---
    const id = nanoid();
    const job = await createJob({
      id,
      userId,
      capability: body.capability,
      idempotencyKey: body.idempotencyKey,
    });

    const payload: QueuedJobPayload = {
      jobId: job.id,
      capability: body.capability,
      inputs: body.inputs,
      userId,
      idempotencyKey: body.idempotencyKey,
    };
    await redis.lpush(JOBS_INCOMING_LIST, JSON.stringify(payload));

    const response: CreateJobResponse = { kind: "job", job };
    return reply.code(201).send(response);
  });

  app.get("/ai/jobs/:id", async (request, reply) => {
    const params = JobIdParamsSchema.safeParse(request.params);
    if (!params.success) {
      return reply.code(400).send({ error: "invalid_request" });
    }
    const stored = await getJob(params.data.id);
    if (!stored) {
      return reply.code(404).send({ error: "not_found" });
    }
    // Phase 0: no ownership enforcement beyond the stub; revisit in Phase 4.
    return reply.send(stored.job);
  });
};
