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
 * Create a new queued job and register its idempotency index.
 * The caller is responsible for enqueuing onto the worker list afterward.
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
