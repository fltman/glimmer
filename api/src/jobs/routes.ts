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
import { getUserId, requireAuth } from "../auth.js";
import { redis, JOBS_INCOMING_LIST } from "../redis.js";
import { presignGet } from "../storage.js";
import {
  claimIdempotency,
  createJob,
  findByIdempotencyKey,
  getJob,
  releaseIdempotency,
} from "./store.js";
import { CreateJobRequestSchema, JobIdParamsSchema } from "./schema.js";
import { reserveCreditsFor } from "../credits/estimate.js";
import { InsufficientCredits, refundAll, reserve } from "../credits/ledger.js";
import { reconcileJob } from "../credits/settle-subscriber.js";
import { routeRateLimit } from "../ratelimit.js";
import { config } from "../config.js";

/** Storage key of the client-side RMBG ONNX weights. */
const RMBG_WEIGHTS_KEY = "models/RMBG-1.4.onnx";

export const jobRoutes: FastifyPluginAsync = async (app) => {
  app.post(
    "/ai/jobs",
    {
      preHandler: requireAuth,
      config: { rateLimit: routeRateLimit(config.rateLimit.aiJobsPerMin) },
    },
    async (request, reply) => {
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

    // --- Atomically CLAIM the idempotency slot BEFORE reserving/enqueuing.
    //     This wins exactly once across concurrent identical POSTs (double-click
    //     / retry), so a duplicate can never reserve + enqueue a second paid
    //     job. The loser returns the winner's job (no reservation, no charge). ---
    const id = nanoid();
    const claim = await claimIdempotency(userId, body.idempotencyKey, id);
    if (!claim.won) {
      const stored = await getJob(claim.existingId);
      if (stored) {
        const response: CreateJobResponse = { kind: "job", job: stored.job };
        return reply.send(response);
      }
      // Rare: the winner claimed but hasn't written the job hash yet. Treat as a
      // transient conflict the client can retry rather than double-charging.
      return reply.code(409).send({
        error: "conflict",
        message: "A duplicate request is in flight; retry shortly.",
      });
    }

    // --- Reserve credits BEFORE enqueuing (so a failed reserve never queues a
    //     paid job). The client_directive path above is free and the
    //     idempotency-hit / lost-claim paths returned already, so none of them
    //     double-charge. ---
    const reserveCredits = reserveCreditsFor(body.capability);
    try {
      await reserve(userId, id, reserveCredits);
    } catch (err) {
      // The reservation failed, so no job will be created for this claim —
      // release it so the user can retry the same action (e.g. after topping
      // up) instead of being wedged behind a dangling claim until its TTL.
      await releaseIdempotency(userId, body.idempotencyKey, id).catch(() => {
        /* best-effort cleanup; the TTL is the backstop */
      });
      if (err instanceof InsufficientCredits) {
        return reply.code(402).send({
          error: "insufficient_credits",
          message: "Not enough credits for this operation",
          required: err.required,
          balance: err.balance,
        });
      }
      throw err;
    }

    // --- Create + enqueue a server job (reservation succeeded). If either step
    //     throws, the job never reaches a worker (so the settle subscriber would
    //     never fire), which would LEAK the reservation. Refund + release on
    //     failure so the held credits come back and the action is retryable. ---
    let job;
    try {
      job = await createJob({
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
    } catch (err) {
      await refundAll({
        jobId: id,
        userId,
        capability: body.capability,
        reason: "enqueue failed",
      }).catch(() => {
        /* best-effort */
      });
      await releaseIdempotency(userId, body.idempotencyKey, id).catch(() => {
        /* best-effort */
      });
      throw err;
    }

    const response: CreateJobResponse = { kind: "job", job };
    return reply.code(201).send(response);
    },
  );

  app.get(
    "/ai/jobs/:id",
    { preHandler: requireAuth },
    async (request, reply) => {
      const params = JobIdParamsSchema.safeParse(request.params);
      if (!params.success) {
        return reply.code(400).send({ error: "invalid_request" });
      }
      const stored = await getJob(params.data.id);
      if (!stored) {
        return reply.code(404).send({ error: "not_found" });
      }
      // Ownership: a user may only read their own jobs. Return 404 (not 403) on
      // mismatch so job ids aren't enumerable. A falsy/empty stored.userId is
      // treated as a NON-match (deny) so a userId-less job is never world-
      // readable — EXCEPT in dev mode, where everyone is the single dev-user.
      const userId = getUserId(request);
      const owned =
        config.auth.devMode ||
        (Boolean(stored.userId) && stored.userId === userId);
      if (!owned) {
        return reply.code(404).send({ error: "not_found" });
      }
      // Reconciliation fallback: if a terminal job was never settled (a missed
      // pub/sub message), settle it now. Idempotent — safe to call on every poll.
      void reconcileJob(stored.job, stored.userId, request.log);
      return reply.send(stored.job);
    },
  );
};
