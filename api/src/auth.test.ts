/**
 * Unit tests for token extraction + the dev-mode auth fallback.
 *
 * The frictionless self-host guarantee: with AUTH_DEV_MODE=true (the default)
 * an unauthenticated request resolves to the dev-user identity rather than
 * 401ing. A present-but-invalid token is still rejected (no silent downgrade).
 */
import { beforeAll, describe, expect, it } from "vitest";
import type { FastifyRequest } from "fastify";

beforeAll(() => {
  process.env.DATABASE_URL ??= "postgresql://aips:aips@localhost:5432/aips";
  process.env.REDIS_URL ??= "redis://localhost:6379/0";
  process.env.MINIO_ROOT_USER ??= "aips";
  process.env.MINIO_ROOT_PASSWORD ??= "aips_dev_password";
  process.env.MINIO_ENDPOINT ??= "minio:9000";
  process.env.MINIO_PUBLIC_ENDPOINT ??= "http://localhost:9000";
  process.env.MINIO_BUCKET ??= "aips";
  process.env.WEB_ORIGIN ??= "http://localhost:5173";
  process.env.JWT_SECRET ??= "test_secret_please_change";
  process.env.OPENROUTER_API_KEY ??= "sk-or-test";
  process.env.AUTH_DEV_MODE = "true";
});

/** Minimal FastifyRequest stand-in for the pure auth helpers. */
function req(
  headers: Record<string, string> = {},
  query: Record<string, unknown> = {},
): FastifyRequest {
  return { headers, query } as unknown as FastifyRequest;
}

describe("extractToken", () => {
  it("reads a Bearer header", async () => {
    const { extractToken } = await import("./auth.js");
    expect(extractToken(req({ authorization: "Bearer abc.def.ghi" }))).toBe(
      "abc.def.ghi",
    );
  });

  it("falls back to ?token= query param", async () => {
    const { extractToken } = await import("./auth.js");
    expect(extractToken(req({}, { token: "qtok" }))).toBe("qtok");
  });

  it("returns null when neither is present", async () => {
    const { extractToken } = await import("./auth.js");
    expect(extractToken(req())).toBeNull();
  });
});

describe("dev-mode auth fallback", () => {
  it("resolves an unauthenticated request to dev-user", async () => {
    const { getAuth, getUserId, DEFAULT_DEV_USER } = await import("./auth.js");
    expect(getUserId(req())).toBe(DEFAULT_DEV_USER);
    expect(getAuth(req())).toEqual({ userId: DEFAULT_DEV_USER, isAdmin: false });
  });

  it("accepts a valid token's identity over the dev fallback", async () => {
    const { signToken } = await import("./auth/jwt.js");
    const { getAuth } = await import("./auth.js");
    const { token } = signToken("real-user");
    expect(getAuth(req({ authorization: `Bearer ${token}` })).userId).toBe(
      "real-user",
    );
  });

  it("rejects a present-but-invalid token even in dev mode", async () => {
    const { getAuth, AuthError } = await import("./auth.js");
    expect(() => getAuth(req({ authorization: "Bearer garbage" }))).toThrow(
      AuthError,
    );
  });
});
