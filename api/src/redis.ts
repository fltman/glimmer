/**
 * Redis clients.
 *
 * ioredis requires a dedicated connection for subscriptions (a connection in
 * subscribe mode cannot issue normal commands), so we keep two clients:
 *   - `redis`    : commands (LPUSH, HSET, GET, PUBLISH, ...)
 *   - `subscriber`: pub/sub SUBSCRIBE only
 */
import { Redis } from "ioredis";
import { config } from "./config.js";

/** General-purpose command client. */
export const redis = new Redis(config.redisUrl, {
  maxRetriesPerRequest: null,
  lazyConnect: false,
});

/** Dedicated subscriber connection (used by the WS relay). */
export const subscriber = new Redis(config.redisUrl, {
  maxRetriesPerRequest: null,
  lazyConnect: false,
});

/**
 * Redis list the worker bridge consumes. The API LPUSHes a JSON
 * `QueuedJobPayload`; the Python worker BRPOPs and dispatches to Celery.
 */
export const JOBS_INCOMING_LIST = "aips:jobs:incoming";

/** Graceful shutdown helper. */
export async function closeRedis(): Promise<void> {
  await Promise.allSettled([redis.quit(), subscriber.quit()]);
}
