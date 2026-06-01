/**
 * Postgres connection pool.
 *
 * A single shared `pg.Pool` built from config.databaseUrl. Used by the credits
 * ledger (reserve → settle → refund). The DB creds live in DATABASE_URL
 * (server-side only) and never reach the browser. The pool is lazy: the first
 * query connects. `closePool` is called on graceful shutdown.
 */
import pg from "pg";
import { config } from "../config.js";

/**
 * pg returns BIGINT (OID 20) as a string by default to avoid precision loss.
 * Our credit balances fit comfortably in a JS safe integer, and the API speaks
 * JSON numbers, so parse BIGINT to a number for ergonomic ledger math.
 */
pg.types.setTypeParser(20, (val: string) => Number.parseInt(val, 10));

export const pool = new pg.Pool({
  connectionString: config.databaseUrl,
  // Modest pool for a single-tenant self-host; tune for prod.
  max: 10,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 10_000,
});

/** Run `fn` inside a transaction, committing on success and rolling back on error. */
export async function withTransaction<T>(
  fn: (client: pg.PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {
      /* ignore rollback failure — surface the original error */
    });
    throw err;
  } finally {
    client.release();
  }
}

/** Graceful shutdown helper. */
export async function closePool(): Promise<void> {
  await pool.end();
}
