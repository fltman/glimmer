/**
 * Job persistence — Phase 0 (Redis-backed).
 *
 * Storage layout:
 *   aips:job:<id>            HASH  { json: <serialized Job>, userId: <id> }
 *   aips:idem:<userId>:<key> STRING jobId   (idempotency index)
 *
 * The full Job (per @aips/shared-types) is stored as a JSON blob in the hash's
 * `json` field; we keep `userId` as a separate field for ownership checks
 * without deserializing. Postgres persistence arrives in a later phase.
 */
import type { Capability, Job, JobStatus } from "@aips/shared-types";
import { redis } from "../redis.js";

const JOB_TTL_SECONDS = 60 * 60 * 24; // 24h — Phase 0 jobs are ephemeral
const IDEM_TTL_SECONDS = 60 * 60 * 24;

const jobKey = (id: string): string => `aips:job:${id}`;
const idemKey = (userId: string, idempotencyKey: string): string =>
  `aips:idem:${userId}:${idempotencyKey}`;

export interface StoredJob {
  job: Job;
  userId: string;
}

export interface CreateJobArgs {
  id: string;
  userId: string;
  capability: Capability;
  idempotencyKey: string;
}

/**
 * Atomically CLAIM the idempotency slot for a (user, key) → id mapping.
 *
 * Uses `SET ... NX` so exactly one of N concurrent identical POSTs wins. Returns
 * `{ won: true }` for the winner, or `{ won: false, existingId }` for everyone
 * else (the id the winner already claimed). The route MUST claim BEFORE
 * reserving credits so a duplicate post can never reserve/enqueue a second paid
 * job — closing the concurrent double-charge race.
 */
export async function claimIdempotency(
  userId: string,
  idempotencyKey: string,
  id: string,
): Promise<{ won: true } | { won: false; existingId: string }> {
  const key = idemKey(userId, idempotencyKey);
  const ok = await redis.set(key, id, "EX", IDEM_TTL_SECONDS, "NX");
  if (ok === "OK") return { won: true };
  // Lost the race (or a prior identical post already claimed it).
  const existingId = (await redis.get(key)) ?? id;
  return { won: false, existingId };
}

/**
 * Release an idempotency claim that never produced a job (e.g. the reservation
 * failed with 402, or job creation threw). Only deletes the slot when it still
 * points at OUR id, so we never clobber a different request's claim. This lets
 * the user retry the same action (e.g. after topping up) instead of being stuck
 * behind a dangling claim until its TTL expires.
 */
export async function releaseIdempotency(
  userId: string,
  idempotencyKey: string,
  id: string,
): Promise<void> {
  const key = idemKey(userId, idempotencyKey);
  const current = await redis.get(key);
  if (current === id) {
    await redis.del(key);
  }
}

/**
 * Create a new queued job. The idempotency slot must already be CLAIMED via
 * `claimIdempotency` (the route does this before reserving), so this only
 * writes the job hash. The caller enqueues onto the worker list afterward.
 */
export async function createJob(args: CreateJobArgs): Promise<Job> {
  const job: Job = {
    id: args.id,
    capability: args.capability,
    status: "queued",
    progress: 0,
    stage: "queued",
    artifacts: [],
    createdAt: new Date().toISOString(),
  };

  const multi = redis.multi();
  multi.hset(jobKey(job.id), {
    json: JSON.stringify(job),
    userId: args.userId,
  });
  multi.expire(jobKey(job.id), JOB_TTL_SECONDS);
  // Re-assert the idempotency mapping (the claim already created it; this keeps
  // the TTL aligned with the job and is a no-op for the winner).
  multi.set(
    idemKey(args.userId, args.idempotencyKey),
    job.id,
    "EX",
    IDEM_TTL_SECONDS,
  );
  await multi.exec();

  return job;
}

/** Fetch a job by id, or null if it has expired / never existed. */
export async function getJob(id: string): Promise<StoredJob | null> {
  const data = await redis.hgetall(jobKey(id));
  if (!data || !data.json) return null;
  return {
    job: JSON.parse(data.json) as Job,
    userId: data.userId ?? "",
  };
}

export interface JobPatch {
  status?: JobStatus;
  progress?: number;
  stage?: Job["stage"];
  providerResolved?: string;
  artifacts?: Job["artifacts"];
  costUsd?: number;
  error?: Job["error"];
  finishedAt?: string;
}

/**
 * Merge a partial update into a stored job. Returns the updated job, or null
 * if the job no longer exists. Note: workers update jobs directly in Redis
 * too; this is the API-side path (e.g. cancellation, re-sync writes).
 */
export async function updateJob(
  id: string,
  patch: JobPatch,
): Promise<Job | null> {
  const existing = await getJob(id);
  if (!existing) return null;

  const next: Job = { ...existing.job, ...patch };
  await redis.hset(jobKey(id), { json: JSON.stringify(next) });
  // refresh TTL on activity
  await redis.expire(jobKey(id), JOB_TTL_SECONDS);
  return next;
}

/** Look up an existing job id for an idempotency key (dedup). */
export async function findByIdempotencyKey(
  userId: string,
  idempotencyKey: string,
): Promise<Job | null> {
  const id = await redis.get(idemKey(userId, idempotencyKey));
  if (!id) return null;
  const stored = await getJob(id);
  return stored?.job ?? null;
}
