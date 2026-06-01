/**
 * Unit tests for the pure credit-math helpers (no DB / no network).
 *
 * These import `../config.js`, which validates env at module load, so we set
 * the minimal required env BEFORE importing. Keeps the suite hermetic.
 */
import { beforeAll, describe, expect, it } from "vitest";

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
  // Pin the multiplier + rate so the math is deterministic.
  process.env.CREDIT_SAFETY_MULTIPLIER = "1.5";
  process.env.CREDITS_PER_USD = "100";
});

describe("credit estimates", () => {
  it("reserves estimate × safety multiplier (rounded up)", async () => {
    const { CAPABILITY_COST_CREDITS, reserveCreditsFor } = await import(
      "./estimate.js"
    );
    // text_to_image estimate is 6 → 6 × 1.5 = 9
    expect(CAPABILITY_COST_CREDITS.text_to_image).toBe(6);
    expect(reserveCreditsFor("text_to_image")).toBe(9);
    // segment estimate is 1 → ceil(1.5) = 2
    expect(reserveCreditsFor("segment")).toBe(2);
    // remove_background estimate is 0 (client-side) → reserves nothing
    expect(reserveCreditsFor("remove_background")).toBe(0);
  });

  it("converts USD to credits (ceil)", async () => {
    const { usdToCredits } = await import("./estimate.js");
    expect(usdToCredits(0.04)).toBe(4);
    expect(usdToCredits(0.041)).toBe(5); // 4.1 → 5
    expect(usdToCredits(0)).toBe(0);
  });
});

describe("jwt sign/verify", () => {
  it("round-trips a token and rejects tampering", async () => {
    const { signToken, verifyToken } = await import("../auth/jwt.js");
    const { token } = signToken("user-123", { isAdmin: true });
    const claims = verifyToken(token);
    expect(claims).not.toBeNull();
    expect(claims?.userId).toBe("user-123");
    expect(claims?.isAdmin).toBe(true);

    // A garbage token verifies to null (never throws).
    expect(verifyToken("not-a-jwt")).toBeNull();
    expect(verifyToken(token + "x")).toBeNull();
  });

  it("rejects an EXPIRED token (exp is enforced)", async () => {
    const jwt = (await import("jsonwebtoken")).default;
    const { verifyToken } = await import("../auth/jwt.js");
    const { config } = await import("../config.js");
    // Mint a token that expired an hour ago, signed with the real secret +
    // issuer so only the exp check can reject it.
    const expired = jwt.sign(
      { sub: "user-123", isAdmin: false },
      config.api.jwtSecret,
      { algorithm: "HS256", issuer: config.auth.jwtIssuer, expiresIn: -3600 },
    );
    expect(verifyToken(expired)).toBeNull();
  });

  it("rejects a token signed with the WRONG secret", async () => {
    const jwt = (await import("jsonwebtoken")).default;
    const { verifyToken } = await import("../auth/jwt.js");
    const { config } = await import("../config.js");
    const forged = jwt.sign(
      { sub: "attacker", isAdmin: true },
      "a-different-secret",
      { algorithm: "HS256", issuer: config.auth.jwtIssuer, expiresIn: 3600 },
    );
    expect(verifyToken(forged)).toBeNull();
  });

  it("rejects a token with the WRONG issuer", async () => {
    const jwt = (await import("jsonwebtoken")).default;
    const { verifyToken } = await import("../auth/jwt.js");
    const { config } = await import("../config.js");
    const wrongIss = jwt.sign(
      { sub: "user-123", isAdmin: false },
      config.api.jwtSecret,
      { algorithm: "HS256", issuer: "not-aips", expiresIn: 3600 },
    );
    expect(verifyToken(wrongIss)).toBeNull();
  });
});
