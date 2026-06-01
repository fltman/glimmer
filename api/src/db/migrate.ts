/**
 * Idempotent boot migrations.
 *
 * Chosen mechanism: plain `CREATE TABLE IF NOT EXISTS` DDL run once on API boot
 * inside a single transaction. No migration tool — acceptable for this
 * single-tenant self-host, and safe to run on every boot. `buildApp()` calls
 * `migrate()` before routes register; compose already gates the API on a
 * healthy Postgres, so a DB-down at boot fails fast with a clear log.
 *
 * Schema (credits ledger):
 *   users               — every known identity (incl. dev-user).
 *   user_credits        — current integer balance per user.
 *   credit_transactions — append-only ledger (grant/reserve/settle/refund).
 *                         The PARTIAL UNIQUE(job_id, kind) index is what makes
 *                         settle/refund EXACTLY-ONCE under duplicate terminal
 *                         publishes (WS + poll + worker re-publish).
 *   ai_usage            — one billed row per settled job / sync call (for the
 *                         usage read endpoints). UNIQUE(job_id) double-guards.
 */
import { pool } from "./pool.js";

const DDL = `
CREATE TABLE IF NOT EXISTS users (
  id          TEXT PRIMARY KEY,
  is_admin    BOOLEAN NOT NULL DEFAULT false,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS user_credits (
  user_id         TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  balance_credits BIGINT NOT NULL DEFAULT 0,
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS credit_transactions (
  id          BIGSERIAL PRIMARY KEY,
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind        TEXT NOT NULL CHECK (kind IN ('grant','reserve','settle','refund')),
  -- signed credits: reserve is negative, grant/refund positive, settle is the
  -- net adjustment applied at settle time (usually a positive refund delta).
  credits     BIGINT NOT NULL,
  job_id      TEXT,
  reason      TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- EXACTLY-ONCE guard: at most one settle (and one refund) row per job. A
-- duplicate terminal publish hits ON CONFLICT DO NOTHING and changes nothing.
CREATE UNIQUE INDEX IF NOT EXISTS credit_tx_job_kind_uniq
  ON credit_transactions (job_id, kind)
  WHERE job_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS credit_tx_user_created_idx
  ON credit_transactions (user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS ai_usage (
  id            BIGSERIAL PRIMARY KEY,
  user_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  job_id        TEXT,
  capability    TEXT NOT NULL,
  model         TEXT,
  raw_cost_usd  NUMERIC(12,6),
  billed_credits BIGINT NOT NULL,
  latency_ms    INTEGER,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS ai_usage_job_uniq
  ON ai_usage (job_id)
  WHERE job_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS ai_usage_user_created_idx
  ON ai_usage (user_id, created_at DESC);
`;

/** Apply the schema. Idempotent; safe to call on every boot. */
export async function migrate(): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(DDL);
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {
      /* surface the original error */
    });
    throw err;
  } finally {
    client.release();
  }
}
