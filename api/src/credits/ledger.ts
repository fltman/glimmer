/**
 * Credits ledger — reserve → settle → refund, all single-transaction.
 *
 * Lifecycle:
 *   reserve(userId, jobId, credits)  — SELECT … FOR UPDATE the balance; if
 *       insufficient throw InsufficientCredits; debit the balance; insert a
 *       signed `reserve` (negative) txn. Called BEFORE enqueuing a job (or at
 *       the start of a sync endpoint).
 *   settle(jobId, …)                 — idempotent (UNIQUE(job_id,'settle')):
 *       compute billedCredits from the real provider cost (or fall back to the
 *       reservation when cost is unknown), refund the delta back to the
 *       balance, insert the `settle` txn + the `ai_usage` row. Duplicate
 *       terminal publishes are no-ops.
 *   refundAll(jobId, …)              — idempotent (UNIQUE(job_id,'refund')):
 *       refund the full reservation for a failed/canceled job.
 *
 * Exactly-once settle/refund rests on the partial UNIQUE(job_id, kind) index
 * created in db/migrate.ts.
 */
import type { PoolClient } from "pg";
import { pool, withTransaction } from "../db/pool.js";
import { usdToCredits } from "./estimate.js";
import type { CreditUsageEntry } from "@aips/shared-types";

/** Thrown by reserve() when the balance cannot cover the requested credits. */
export class InsufficientCredits extends Error {
  readonly code = "insufficient_credits" as const;
  readonly required: number;
  readonly balance: number;
  constructor(required: number, balance: number) {
    super(`Insufficient credits: need ${required}, have ${balance}`);
    this.name = "InsufficientCredits";
    this.required = required;
    this.balance = balance;
  }
}

/**
 * Ensure a user row + a zero-balance credit row exist. Idempotent.
 *
 * When `opts.isAdmin === true`, the admin flag is UPGRADED even if the user row
 * already exists (a prior `reserve()`/`grant()` may have inserted the row with
 * the default `is_admin=false`). We never DOWNGRADE here — passing isAdmin:false
 * (or omitting it) leaves an existing admin flag untouched, so a normal
 * ensureUser call can't strip admin from someone who has it.
 */
export async function ensureUser(
  userId: string,
  opts: { isAdmin?: boolean } = {},
): Promise<void> {
  const isAdmin = opts.isAdmin === true;
  await withTransaction(async (c) => {
    await c.query(
      `INSERT INTO users (id, is_admin) VALUES ($1, $2)
       ON CONFLICT (id) DO UPDATE
         SET is_admin = users.is_admin OR EXCLUDED.is_admin`,
      [userId, isAdmin],
    );
    await c.query(
      `INSERT INTO user_credits (user_id, balance_credits) VALUES ($1, 0)
       ON CONFLICT (user_id) DO NOTHING`,
      [userId],
    );
  });
}

/** Current credit balance (0 if the user is unknown). */
export async function getBalance(userId: string): Promise<number> {
  const { rows } = await pool.query<{ balance_credits: number }>(
    `SELECT balance_credits FROM user_credits WHERE user_id = $1`,
    [userId],
  );
  return rows[0]?.balance_credits ?? 0;
}

/** Whether the user is flagged admin. */
export async function isAdminUser(userId: string): Promise<boolean> {
  const { rows } = await pool.query<{ is_admin: boolean }>(
    `SELECT is_admin FROM users WHERE id = $1`,
    [userId],
  );
  return rows[0]?.is_admin ?? false;
}

/** Grant credits (admin/dev top-up or first-login bonus). Returns new balance. */
export async function grant(
  userId: string,
  credits: number,
  reason = "grant",
): Promise<number> {
  return withTransaction(async (c) => {
    await c.query(
      `INSERT INTO users (id) VALUES ($1) ON CONFLICT (id) DO NOTHING`,
      [userId],
    );
    const { rows } = await c.query<{ balance_credits: number }>(
      `INSERT INTO user_credits (user_id, balance_credits, updated_at)
         VALUES ($1, $2, now())
       ON CONFLICT (user_id) DO UPDATE
         SET balance_credits = user_credits.balance_credits + EXCLUDED.balance_credits,
             updated_at = now()
       RETURNING balance_credits`,
      [userId, credits],
    );
    await c.query(
      `INSERT INTO credit_transactions (user_id, kind, credits, reason)
         VALUES ($1, 'grant', $2, $3)`,
      [userId, credits, reason],
    );
    return rows[0]?.balance_credits ?? credits;
  });
}

/**
 * Reserve `credits` against the user's balance for `jobId`. Single tx:
 * locks the balance row, throws InsufficientCredits if it can't cover the
 * amount, else debits and records a negative `reserve` txn. The reserve txn is
 * the single source of truth for "how much was held" at settle time.
 */
export async function reserve(
  userId: string,
  jobId: string,
  credits: number,
): Promise<void> {
  // Zero-cost ops (e.g. the never-enqueued client_directive path) skip the DB.
  if (credits <= 0) return;
  await withTransaction(async (c) => {
    // Ensure the balance row exists so FOR UPDATE has something to lock.
    await c.query(
      `INSERT INTO users (id) VALUES ($1) ON CONFLICT (id) DO NOTHING`,
      [userId],
    );
    await c.query(
      `INSERT INTO user_credits (user_id, balance_credits) VALUES ($1, 0)
       ON CONFLICT (user_id) DO NOTHING`,
      [userId],
    );
    const { rows } = await c.query<{ balance_credits: number }>(
      `SELECT balance_credits FROM user_credits WHERE user_id = $1 FOR UPDATE`,
      [userId],
    );
    const balance = rows[0]?.balance_credits ?? 0;
    if (balance < credits) {
      throw new InsufficientCredits(credits, balance);
    }
    await c.query(
      `UPDATE user_credits
         SET balance_credits = balance_credits - $2, updated_at = now()
       WHERE user_id = $1`,
      [userId, credits],
    );
    await c.query(
      `INSERT INTO credit_transactions (user_id, kind, credits, job_id, reason)
         VALUES ($1, 'reserve', $2, $3, 'job reservation')`,
      [userId, -credits, jobId],
    );
  });
}

/** Read the (positive) reserved amount for a job, or 0 if none. */
async function reservedFor(c: PoolClient, jobId: string): Promise<number> {
  const { rows } = await c.query<{ credits: number }>(
    `SELECT credits FROM credit_transactions
       WHERE job_id = $1 AND kind = 'reserve' LIMIT 1`,
    [jobId],
  );
  const signed = rows[0]?.credits ?? 0;
  return Math.abs(signed);
}

export interface SettleArgs {
  jobId: string;
  userId: string;
  capability: string;
  model: string | null;
  /** Real provider cost in USD, or null when unknown (local/no-provider pass). */
  rawCostUsd: number | null;
  latencyMs?: number | null;
}

/**
 * Settle a job EXACTLY ONCE. Idempotent via the partial UNIQUE(job_id,'settle')
 * index. Computes billedCredits from rawCostUsd (falling back to the
 * reservation when cost is unknown, e.g. segment/base-upscale/color_match),
 * refunds the delta (reserved − billed) back to the balance, and records the
 * settle txn + ai_usage row. A duplicate publish does nothing.
 */
export async function settle(args: SettleArgs): Promise<void> {
  await withTransaction(async (c) => {
    // Claim the settle slot first; if it already exists, this is a duplicate.
    const claim = await c.query(
      `INSERT INTO credit_transactions (user_id, kind, credits, job_id, reason)
         VALUES ($1, 'settle', 0, $2, 'placeholder')
       ON CONFLICT (job_id, kind) WHERE job_id IS NOT NULL DO NOTHING
       RETURNING id`,
      [args.userId, args.jobId],
    );
    if (claim.rowCount === 0) {
      // Already settled — exactly-once. (A refund row uses a DIFFERENT `kind`
      // slot, so it does NOT block this INSERT; the explicit refund check below
      // is what keeps settle and refund mutually exclusive on the BALANCE.)
      return;
    }
    const settleTxnId = claim.rows[0].id as number;

    const reserved = await reservedFor(c, args.jobId);
    const billed =
      args.rawCostUsd != null && args.rawCostUsd > 0
        ? usdToCredits(args.rawCostUsd)
        : reserved; // unknown cost → bill the reservation (no surprise refund)

    // Lock the user's balance row FIRST — before the cross-check below — so this
    // settle and a concurrent refundAll() serialize on the SAME row. Whichever
    // grabs the lock first commits its terminal row before the other reads, so
    // the loser's cross-check reliably sees it. (READ COMMITTED only reveals a
    // row after the writer commits; the shared FOR UPDATE lock is what forces
    // that ordering instead of letting both run their check-then-act blindly.)
    const { rows: lockRows } = await c.query<{ balance_credits: number }>(
      `SELECT balance_credits FROM user_credits WHERE user_id = $1 FOR UPDATE`,
      [args.userId],
    );
    const current = lockRows[0]?.balance_credits ?? 0;

    // SYMMETRY WITH refundAll(): the partial UNIQUE(job_id,kind) index only
    // enforces one row PER KIND, so a 'settle' and a 'refund' row can coexist
    // for the same job. refundAll() guards against a prior settle; settle() must
    // guard against a prior refund — otherwise an enqueue-failure refund (full
    // reservation returned) followed by a worker success that settles would
    // credit the balance TWICE (refund of `reserved` + settle's `reserved -
    // billed`), a money leak in the user's favour and a violation of the
    // "settle and refund are mutually exclusive" invariant. If a refund already
    // returned the reservation, record a 0-delta settle txn + the ai_usage row
    // for audit but DO NOT touch the balance.
    const refundedAlready = await c.query(
      `SELECT 1 FROM credit_transactions
         WHERE job_id = $1 AND kind = 'refund' LIMIT 1`,
      [args.jobId],
    );
    const wasRefunded = (refundedAlready.rowCount ?? 0) > 0;

    // Compute the settle adjustment under the row lock acquired above.
    //   refundDelta = reserved - billed
    //     > 0  → refund the unused part of the reservation
    //     < 0  → real cost exceeded the reserve: claw back the overage, but
    //            FLOOR the balance at 0 so a user can never go negative.
    // When the job was already fully refunded, force a 0 balance adjustment.
    const refundDelta = wasRefunded ? 0 : reserved - billed;
    let appliedDelta = refundDelta;
    if (refundDelta !== 0) {
      // Never push the balance below zero (overage clawback is capped at the
      // available balance). A positive refund is always applied in full.
      appliedDelta =
        refundDelta < 0 ? -Math.min(current, -refundDelta) : refundDelta;
      if (appliedDelta !== 0) {
        await c.query(
          `UPDATE user_credits
             SET balance_credits = balance_credits + $2, updated_at = now()
           WHERE user_id = $1`,
          [args.userId, appliedDelta],
        );
      }
    }
    // Record the ACTUAL net adjustment on the settle txn for auditability (so
    // the ledger sum matches the balance even when an overage was capped).
    await c.query(
      `UPDATE credit_transactions
         SET credits = $2, reason = 'job settled'
       WHERE id = $1`,
      [settleTxnId, appliedDelta],
    );
    await c.query(
      `INSERT INTO ai_usage
         (user_id, job_id, capability, model, raw_cost_usd, billed_credits, latency_ms)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (job_id) WHERE job_id IS NOT NULL DO NOTHING`,
      [
        args.userId,
        args.jobId,
        args.capability,
        args.model,
        args.rawCostUsd,
        billed,
        args.latencyMs ?? null,
      ],
    );
  });
}

export interface RefundArgs {
  jobId: string;
  userId: string;
  capability: string;
  reason?: string;
}

/**
 * Refund the FULL reservation for a failed/canceled job. Idempotent via the
 * partial UNIQUE(job_id,'refund') index. If the job was already settled, the
 * settle slot is taken and a refund here is a no-op for the same job id (settle
 * and refund are mutually exclusive terminal outcomes).
 */
export async function refundAll(args: RefundArgs): Promise<void> {
  await withTransaction(async (c) => {
    // Lock the user's balance row FIRST so this refund and a concurrent settle()
    // serialize on the SAME row (see settle() for the full rationale). Without
    // this shared lock, both could run their check-then-act before either
    // committed its terminal row and BOTH credit the balance — the exact
    // settle+refund double-apply this guard prevents.
    await c.query(
      `SELECT balance_credits FROM user_credits WHERE user_id = $1 FOR UPDATE`,
      [args.userId],
    );

    // A settled job must not also be refunded. (Read AFTER taking the lock so a
    // settle that committed first is reliably visible.)
    const already = await c.query(
      `SELECT 1 FROM credit_transactions
         WHERE job_id = $1 AND kind = 'settle' LIMIT 1`,
      [args.jobId],
    );
    if ((already.rowCount ?? 0) > 0) return;

    const reserved = await reservedFor(c, args.jobId);
    const claim = await c.query(
      `INSERT INTO credit_transactions (user_id, kind, credits, job_id, reason)
         VALUES ($1, 'refund', $2, $3, $4)
       ON CONFLICT (job_id, kind) WHERE job_id IS NOT NULL DO NOTHING
       RETURNING id`,
      [args.userId, reserved, args.jobId, args.reason ?? "job failed/canceled"],
    );
    if (claim.rowCount === 0) return; // already refunded
    if (reserved > 0) {
      await c.query(
        `UPDATE user_credits
           SET balance_credits = balance_credits + $2, updated_at = now()
         WHERE user_id = $1`,
        [args.userId, reserved],
      );
    }
  });
}

/** Recent billed usage rows for a user (most recent first). */
export async function getUsage(
  userId: string,
  limit = 50,
): Promise<CreditUsageEntry[]> {
  const { rows } = await pool.query<{
    job_id: string | null;
    capability: string;
    model: string | null;
    raw_cost_usd: string | null;
    billed_credits: number;
    latency_ms: number | null;
    created_at: Date;
  }>(
    `SELECT job_id, capability, model, raw_cost_usd, billed_credits, latency_ms, created_at
       FROM ai_usage
       WHERE user_id = $1
       ORDER BY created_at DESC
       LIMIT $2`,
    [userId, limit],
  );
  return rows.map((r) => ({
    jobId: r.job_id,
    capability: r.capability,
    model: r.model,
    rawCostUsd: r.raw_cost_usd != null ? Number(r.raw_cost_usd) : null,
    billedCredits: r.billed_credits,
    latencyMs: r.latency_ms,
    createdAt: r.created_at.toISOString(),
  }));
}
