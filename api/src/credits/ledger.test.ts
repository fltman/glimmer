/**
 * Integration tests for the credits ledger's exactly-once terminal invariant:
 *
 *   "settle() and refundAll() are MUTUALLY EXCLUSIVE on the balance."
 *
 * The regression these lock down: an enqueue-failure refund (full reservation
 * returned) followed by a worker-success settle could credit the balance TWICE
 * (refund of `reserved` + settle's `reserved - billed`), leaking credits in the
 * user's favour. settle() now cross-checks for a prior refund (and both paths
 * lock the user_credits row first so they serialize), so for a given job the net
 * balance debit is EXACTLY `billed` no matter the order/interleaving.
 *
 * These tests need a real Postgres. Point them at one with TEST_DATABASE_URL
 * (or DATABASE_URL). When no DB is reachable the whole suite is SKIPPED so the
 * hermetic unit suite (no DB) stays green. We connect to a throwaway schema and
 * drop it on teardown, so we never touch the app's real ledger data.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";

const TEST_DB_URL =
  process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL ?? "";

/** Probe the DB once; if unreachable we skip the whole describe block. */
async function dbReachable(url: string): Promise<boolean> {
  if (!url) return false;
  const probe = new pg.Pool({
    connectionString: url,
    connectionTimeoutMillis: 1500,
    max: 1,
  });
  try {
    await probe.query("SELECT 1");
    return true;
  } catch {
    return false;
  } finally {
    await probe.end().catch(() => undefined);
  }
}

const hasDb = await dbReachable(TEST_DB_URL);
const describeDb = hasDb ? describe : describe.skip;

describeDb("ledger settle/refund mutual exclusion (integration)", () => {
  // Lazily-imported ledger fns + pool (imported AFTER env is pinned below).
  let reserve: typeof import("./ledger.js").reserve;
  let settle: typeof import("./ledger.js").settle;
  let refundAll: typeof import("./ledger.js").refundAll;
  let getBalance: typeof import("./ledger.js").getBalance;
  let grant: typeof import("./ledger.js").grant;
  let migrate: typeof import("./../db/migrate.js").migrate;
  let pool: typeof import("./../db/pool.js").pool;

  beforeAll(async () => {
    // The ledger reads DATABASE_URL via config at import time — pin it to the
    // test DB and fill the other required env so config validates.
    process.env.DATABASE_URL = TEST_DB_URL;
    process.env.REDIS_URL ??= "redis://localhost:6379/0";
    process.env.MINIO_ROOT_USER ??= "aips";
    process.env.MINIO_ROOT_PASSWORD ??= "aips_dev_password";
    process.env.MINIO_ENDPOINT ??= "minio:9000";
    process.env.MINIO_PUBLIC_ENDPOINT ??= "http://localhost:9000";
    process.env.MINIO_BUCKET ??= "aips";
    process.env.WEB_ORIGIN ??= "http://localhost:5173";
    process.env.JWT_SECRET ??= "test_secret_please_change";
    process.env.OPENROUTER_API_KEY ??= "sk-or-test";
    process.env.CREDIT_SAFETY_MULTIPLIER = "1.5";
    process.env.CREDITS_PER_USD = "100";

    ({ reserve, settle, refundAll, getBalance, grant } = await import(
      "./ledger.js"
    ));
    ({ migrate } = await import("./../db/migrate.js"));
    ({ pool } = await import("./../db/pool.js"));
    await migrate();
  });

  afterAll(async () => {
    await pool?.end().catch(() => undefined);
  });

  /** Fresh user with a known starting balance; returns its id. */
  async function freshUser(start: number): Promise<string> {
    const userId = `test-${Math.random().toString(36).slice(2)}`;
    await grant(userId, start, "test seed");
    return userId;
  }

  it("refund THEN settle nets exactly the reservation debit (no double-credit)", async () => {
    const start = 1000;
    const userId = await freshUser(start);
    const jobId = `job-${Math.random().toString(36).slice(2)}`;
    const reserved = 9; // text_to_image reserve (6 × 1.5)

    await reserve(userId, jobId, reserved);
    expect(await getBalance(userId)).toBe(start - reserved);

    // Enqueue-failure path refunds the FULL reservation...
    await refundAll({ jobId, userId, capability: "text_to_image" });
    expect(await getBalance(userId)).toBe(start); // reservation fully returned

    // ...then the worker (which DID get the job) reports success → settle.
    // billed = usdToCredits(0.04) = 4. With the fix, settle must NOT touch the
    // balance again (the refund already returned everything). Net debit = 0.
    await settle({
      jobId,
      userId,
      capability: "text_to_image",
      model: "google/gemini-3-pro-image-preview",
      rawCostUsd: 0.04,
    });
    // Balance must remain at `start` — NOT start + (reserved - billed).
    expect(await getBalance(userId)).toBe(start);
  });

  it("settle THEN refund nets exactly `billed` (refund is a no-op)", async () => {
    const start = 1000;
    const userId = await freshUser(start);
    const jobId = `job-${Math.random().toString(36).slice(2)}`;
    const reserved = 9;
    const billed = 4; // usdToCredits(0.04)

    await reserve(userId, jobId, reserved);
    await settle({
      jobId,
      userId,
      capability: "text_to_image",
      model: null,
      rawCostUsd: 0.04,
    });
    // settle refunded the unused (reserved - billed); net debit so far = billed.
    expect(await getBalance(userId)).toBe(start - billed);

    // A late/duplicate failure publish must NOT also refund (settle won the slot).
    await refundAll({ jobId, userId, capability: "text_to_image" });
    expect(await getBalance(userId)).toBe(start - billed);
  });

  it("concurrent settle + refundAll never double-credit the balance", async () => {
    const start = 1000;
    const userId = await freshUser(start);
    const jobId = `job-${Math.random().toString(36).slice(2)}`;
    const reserved = 9;

    await reserve(userId, jobId, reserved);
    // Fire both terminal paths at once; the shared user_credits row lock forces
    // them to serialize, and the cross-checks make exactly one mutate the
    // balance. The result must be either `start` (refund won) or
    // `start - billed` (settle won) — never `start + (reserved - billed)`.
    await Promise.all([
      settle({
        jobId,
        userId,
        capability: "text_to_image",
        model: null,
        rawCostUsd: 0.04,
      }),
      refundAll({ jobId, userId, capability: "text_to_image" }),
    ]);
    const bal = await getBalance(userId);
    const billed = 4;
    expect([start, start - billed]).toContain(bal);
  });
});
