/**
 * Auth — JWT verification with a frictionless DEV-MODE fallback.
 *
 * A request is authenticated by a signed JWT presented EITHER as a
 * `Authorization: Bearer <token>` header OR a `?token=<token>` query param
 * (the latter is needed for the WS upgrade and presigned <a href> links, which
 * cannot set headers). The token is minted server-side (see auth/jwt.ts).
 *
 * DEV MODE (config.auth.devMode, default true): when no/invalid token is
 * present we transparently fall back to the "dev-user" identity so the
 * single-user self-host works with no login at all. In production
 * (AUTH_DEV_MODE=false) a missing/invalid token throws `AuthError`, which the
 * `requireAuth` preHandler maps to a clean 401.
 *
 * `getUserId(req): string` keeps its original signature so existing call sites
 * are unchanged.
 */
import type { FastifyReply, FastifyRequest } from "fastify";
import { config } from "./config.js";
import { verifyToken, type AuthClaims } from "./auth/jwt.js";

/** Fallback identity used in dev mode when no valid token is present. */
export const DEFAULT_DEV_USER = "dev-user";

/** Thrown when auth is required but missing/invalid (prod). Mapped to 401. */
export class AuthError extends Error {
  readonly status = 401 as const;
  readonly code: "unauthorized";
  constructor(message = "Authentication required") {
    super(message);
    this.name = "AuthError";
    this.code = "unauthorized";
  }
}

/** Pull a bearer token from the Authorization header or `?token=` query param. */
export function extractToken(request: FastifyRequest): string | null {
  const auth = request.headers.authorization;
  if (typeof auth === "string") {
    const m = /^Bearer\s+(.+)$/i.exec(auth.trim());
    if (m?.[1]) return m[1].trim();
  }
  const q = (request.query as { token?: unknown } | undefined)?.token;
  if (typeof q === "string" && q.length > 0) return q;
  if (Array.isArray(q) && typeof q[0] === "string" && q[0].length > 0) {
    return q[0];
  }
  return null;
}

/**
 * Resolve the authenticated identity (userId + isAdmin).
 *
 * - Valid token → its claims (in any mode).
 * - Present-but-invalid token → ALWAYS throws AuthError (even in dev mode), so
 *   a tampered/expired token is never silently downgraded to dev-user.
 * - NO token + dev mode → the frictionless dev-user identity (non-admin).
 * - NO token + prod → throws AuthError.
 */
export function getAuth(request: FastifyRequest): AuthClaims {
  const raw = extractToken(request);
  if (raw) {
    const claims = verifyToken(raw);
    if (claims) return claims;
    // A present-but-invalid token is always an error, even in dev mode.
    throw new AuthError("Invalid or expired token");
  }
  // No token at all: dev mode auto-accepts the dev identity; prod rejects.
  if (config.auth.devMode) {
    return { userId: DEFAULT_DEV_USER, isAdmin: false };
  }
  throw new AuthError();
}

/**
 * Returns a stable user id for the request. Unchanged signature.
 * Delegates to getAuth (throws AuthError in prod when unauthenticated).
 */
export function getUserId(request: FastifyRequest): string {
  return getAuth(request).userId;
}

/**
 * Fastify preHandler enforcing authentication. In dev mode it transparently
 * accepts dev-user (frictionless); in prod it 401s on missing/invalid tokens.
 * Register per-route (NOT globally) so /health and /auth/dev-login stay open.
 */
export function requireAuth(
  request: FastifyRequest,
  reply: FastifyReply,
  done: (err?: Error) => void,
): void {
  try {
    // Resolve + cache the identity on the request for downstream handlers.
    const auth = getAuth(request);
    (request as FastifyRequest & { auth?: AuthClaims }).auth = auth;
    done();
  } catch (err) {
    if (err instanceof AuthError) {
      void reply.code(401).send({ error: err.code, message: err.message });
      return;
    }
    done(err as Error);
  }
}
