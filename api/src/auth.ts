/**
 * Auth — Phase 0 stub.
 *
 * Real auth (JWT issue/verify, accounts) lands in Phase 4. For now we derive a
 * stable user id from a header so the rest of the system (per-user storage
 * keys, job ownership) can be wired correctly today. Isolated here so swapping
 * in real verification is a one-file change.
 */
import type { FastifyRequest } from "fastify";

/** Header the dev client sends to identify itself. */
const DEV_USER_HEADER = "x-aips-user";

/** Fallback dev user when no header is present (single-tenant local dev). */
const DEFAULT_DEV_USER = "dev-user";

/**
 * Returns a stable string user id for the request.
 *
 * Phase 0: trusts `x-aips-user` (or a default). Phase 4 will verify a signed
 * JWT (Bearer header or `?token=` query param) using `config.api.jwtSecret`.
 */
export function getUserId(request: FastifyRequest): string {
  const header = request.headers[DEV_USER_HEADER];
  const value = Array.isArray(header) ? header[0] : header;
  const id = (value ?? "").trim();
  return id.length > 0 ? id : DEFAULT_DEV_USER;
}
