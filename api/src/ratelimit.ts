/**
 * Rate limiting — @fastify/rate-limit backed by the shared Redis client.
 *
 * Chosen over a hand-rolled INCR limiter: zero bespoke code, standard 429 +
 * Retry-After / RateLimit-* headers, per-route overrides, a custom
 * keyGenerator, and it reuses the Redis we already run (no new infra).
 *
 * Registration (server.ts):
 *   - Global default budget (RATE_LIMIT_PER_MIN_DEFAULT), keyed by the
 *     authenticated user id when present, else the client IP (covers both the
 *     authed and the dev-unauthenticated path).
 *   - Per-route tighter caps via `routeRateLimit(max)` on config.rateLimit for
 *     the money/provider endpoints (/ai/jobs, /ai/agent, /ai/analyze-distractions).
 *   - Entirely disabled when RATE_LIMIT_DEV_DISABLED (frictionless self-host).
 *
 * /health and /auth/dev-login are exempted (they pass `rateLimit:false`).
 */
import type { FastifyInstance, FastifyRequest } from "fastify";
import rateLimit from "@fastify/rate-limit";
import { config } from "./config.js";
import { redis } from "./redis.js";
import { extractToken } from "./auth.js";
import { verifyToken } from "./auth/jwt.js";

/**
 * Key a request by user id (preferred) or client IP (fallback). We can't call
 * getUserId() here because in prod it throws on missing tokens (the limiter
 * must still bucket unauthenticated requests by IP), so we verify softly.
 */
function keyGenerator(request: FastifyRequest): string {
  const raw = extractToken(request);
  if (raw) {
    const claims = verifyToken(raw);
    if (claims) return `u:${claims.userId}`;
  }
  return `ip:${request.ip}`;
}

/** Register the global rate limiter. No-op when disabled in dev. */
export async function registerRateLimit(app: FastifyInstance): Promise<void> {
  if (config.rateLimit.devDisabled) {
    app.log.info("rate limiting disabled (RATE_LIMIT_DEV_DISABLED=true)");
    return;
  }
  await app.register(rateLimit, {
    global: true,
    max: config.rateLimit.perMinDefault,
    timeWindow: "1 minute",
    redis,
    keyGenerator,
    // Keep the 429 body consistent with the rest of the `{error,...}` envelope.
    errorResponseBuilder: (_req, ctx) => ({
      error: "rate_limited",
      message: `Rate limit exceeded. Retry in ${Math.ceil(ctx.ttl / 1000)}s.`,
      retryAfterSeconds: Math.ceil(ctx.ttl / 1000),
    }),
  });
}

/**
 * Per-route override object for `config.rateLimit`. Use on the costly routes:
 *   app.post("/ai/jobs", { config: { rateLimit: routeRateLimit(max) } }, …)
 * Returns undefined when limiting is disabled so the route config stays clean.
 */
export function routeRateLimit(
  max: number,
): { max: number; timeWindow: string } | false {
  if (config.rateLimit.devDisabled) return false;
  return { max, timeWindow: "1 minute" };
}
