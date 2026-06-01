/**
 * JWT sign/verify — HS256, server-side only.
 *
 * The secret (config.api.jwtSecret) NEVER leaves this process. Tokens carry a
 * minimal claim set: `sub` (user id), `iss`, optional `isAdmin`, plus the
 * standard `iat`/`exp`. They are minted by the auth routes and verified on
 * every protected request (see ../auth.ts). 30-day default TTL mirrors the
 * project's house JWT pattern.
 */
import jwt from "jsonwebtoken";
import { config } from "../config.js";

export interface AuthClaims {
  userId: string;
  isAdmin: boolean;
}

interface RawClaims {
  sub: string;
  iss?: string;
  isAdmin?: boolean;
}

/** Sign a token for `userId`. `expiresAt` is the Unix-second expiry. */
export function signToken(
  userId: string,
  opts: { isAdmin?: boolean } = {},
): { token: string; expiresAt: number } {
  const ttl = config.auth.jwtTtlSeconds;
  const token = jwt.sign(
    { sub: userId, isAdmin: opts.isAdmin === true },
    config.api.jwtSecret,
    {
      algorithm: "HS256",
      issuer: config.auth.jwtIssuer,
      expiresIn: ttl,
    },
  );
  const expiresAt = Math.floor(Date.now() / 1000) + ttl;
  return { token, expiresAt };
}

/**
 * Verify a raw token. Returns the claims on success, or null on any failure
 * (bad signature, wrong issuer, expired, malformed). Never throws.
 */
export function verifyToken(raw: string): AuthClaims | null {
  try {
    const decoded = jwt.verify(raw, config.api.jwtSecret, {
      algorithms: ["HS256"],
      issuer: config.auth.jwtIssuer,
    }) as RawClaims;
    if (!decoded || typeof decoded.sub !== "string" || decoded.sub.length === 0) {
      return null;
    }
    return { userId: decoded.sub, isAdmin: decoded.isAdmin === true };
  } catch {
    return null;
  }
}
