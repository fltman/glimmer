/**
 * Always-on credit settlement subscriber.
 *
 * The single best place to settle credits is here — a dedicated Redis pub/sub
 * subscriber in the API process — NOT the per-socket WS relay (which only
 * exists while a client is watching and would miss settles on reconnect /
 * headless runs). This pattern-subscribes to `job:*` and, on every terminal
 * job_update, settles (succeeded) or refunds (failed/canceled) EXACTLY ONCE.
 *
 * Exactly-once rests on the UNIQUE(job_id, kind) ledger index, so duplicate
 * terminal publishes (WS + poll re-sync + worker re-publish) are harmless.
 *
 * A reconciliation fallback (`reconcileJob`) lets GET /ai/jobs/:id trigger the
 * same idempotent settle if a pub/sub message was ever missed.
 */
import { Redis } from "ioredis";
import type { FastifyBaseLogger } from "fastify";
import type { Job } from "@aips/shared-types";
import { config } from "../config.js";
import { getJob } from "../jobs/store.js";
import { refundAll, settle } from "./ledger.js";

const TERMINAL = new Set<Job["status"]>(["succeeded", "failed", "canceled"]);

/**
 * In-process guard to avoid redundant ledger round-trips for the same job. It is
 * only a fast-path optimisation — the DB UNIQUE(job_id,kind) constraint is the
 * real exactly-once guard — so it is safe to bound and evict. Without a cap this
 * Set would grow forever on a long-running API process (one entry per terminal
 * job). We evict the oldest entries (Set preserves insertion order) once the cap
 * is hit; a re-publish of an evicted job just does a harmless idempotent
 * settle/refund that the DB constraint no-ops.
 */
const HANDLED_MAX = 50_000;
const handled = new Set<string>();

function markHandled(jobId: string): void {
  handled.add(jobId);
  if (handled.size > HANDLED_MAX) {
    // Drop the oldest ~10% in one pass to amortise the cost.
    const drop = Math.ceil(HANDLED_MAX * 0.1);
    let i = 0;
    for (const k of handled) {
      handled.delete(k);
      if (++i >= drop) break;
    }
  }
}

/**
 * Apply the terminal outcome of `job` to the ledger. Idempotent at both the
 * in-process layer (the `handled` set) and the DB layer (UNIQUE(job_id,kind)).
 */
async function applyTerminal(
  jobId: string,
  log: FastifyBaseLogger,
): Promise<void> {
  if (handled.has(jobId)) return;
  const stored = await getJob(jobId);
  if (!stored) return;
  const { job, userId } = stored;
  if (!TERMINAL.has(job.status)) return;
  // Mark handled before awaiting so concurrent publishes don't double-enter;
  // the DB constraint is the real guard if this races.
  markHandled(jobId);
  try {
    if (job.status === "succeeded") {
      await settle({
        jobId,
        userId,
        capability: job.capability,
        model: job.providerResolved ?? null,
        rawCostUsd: typeof job.costUsd === "number" ? job.costUsd : null,
      });
    } else {
      await refundAll({
        jobId,
        userId,
        capability: job.capability,
        reason: job.error?.code ?? job.status,
      });
    }
  } catch (err) {
    // Settling failed (e.g. transient DB error) — drop the in-process guard so
    // a later publish / reconcile retries.
    handled.delete(jobId);
    log.error({ err, jobId, status: job.status }, "credit settle failed");
  }
}

/**
 * Public reconciliation hook for GET /ai/jobs/:id: if a polled job is terminal
 * but a pub/sub message was missed, settle it now (idempotent).
 */
export async function reconcileJob(
  job: Job,
  userId: string,
  log: FastifyBaseLogger,
): Promise<void> {
  if (!TERMINAL.has(job.status)) return;
  if (handled.has(job.id)) return;
  markHandled(job.id);
  try {
    if (job.status === "succeeded") {
      await settle({
        jobId: job.id,
        userId,
        capability: job.capability,
        model: job.providerResolved ?? null,
        rawCostUsd: typeof job.costUsd === "number" ? job.costUsd : null,
      });
    } else {
      await refundAll({
        jobId: job.id,
        userId,
        capability: job.capability,
        reason: job.error?.code ?? job.status,
      });
    }
  } catch (err) {
    handled.delete(job.id);
    log.error({ err, jobId: job.id }, "credit reconcile failed");
  }
}

/**
 * Start the settle subscriber. Returns a stop() for graceful shutdown. Uses its
 * own dedicated subscriber connection (a psubscribing connection can't run
 * normal commands; the ledger uses Postgres, and getJob uses the shared command
 * client, so there is no contention).
 */
export function startSettleSubscriber(log: FastifyBaseLogger): {
  stop: () => Promise<void>;
} {
  const sub = new Redis(config.redisUrl, { maxRetriesPerRequest: null });

  sub.on("pmessage", (_pattern, channel, message) => {
    // channel is `job:<id>`; the worker publishes {type:"job_update", job} (or
    // a bare Job). We only need the id + status, which we re-read from the
    // store to get the authoritative userId/costUsd (the publish may lag).
    let jobId: string | null = null;
    try {
      const parsed = JSON.parse(message) as Record<string, unknown>;
      const job =
        parsed && parsed.type === "job_update" && parsed.job
          ? (parsed.job as Job)
          : "id" in parsed && "status" in parsed
            ? (parsed as unknown as Job)
            : null;
      if (job && TERMINAL.has(job.status)) {
        jobId = job.id;
      }
    } catch {
      // Fall back to deriving the id from the channel name.
      const idx = channel.indexOf(":");
      jobId = idx >= 0 ? channel.slice(idx + 1) : null;
    }
    if (jobId) {
      void applyTerminal(jobId, log);
    }
  });

  void sub.psubscribe("job:*").then(
    () => log.info("credit settle subscriber listening on job:*"),
    (err) => log.error({ err }, "credit settle subscriber psubscribe failed"),
  );

  return {
    stop: async (): Promise<void> => {
      await sub.quit().catch(() => {
        /* ignore */
      });
    },
  };
}
