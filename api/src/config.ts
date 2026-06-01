/**
 * Environment configuration, validated with zod at process start.
 *
 * Env var names mirror `.env.example` exactly. Provider keys are read here
 * (server-side only) and must never be forwarded to the browser.
 */
import { z } from "zod";

const boolish = z
  .string()
  .transform((v) => v === "true" || v === "1")
  .pipe(z.boolean());

/**
 * Known-insecure placeholder values shipped in `.env.example`. They keep the
 * frictionless dev/self-host experience working out of the box, but MUST be
 * overridden before flipping AUTH_DEV_MODE=false. The prod guard below
 * fail-fasts (exit 1) if any of these reach a production boot.
 */
export const PLACEHOLDER_JWT_SECRET = "change_me_in_production";
export const PLACEHOLDER_ADMIN_GRANT_TOKEN = "dev-admin-token";
/** Minimum JWT secret length we accept in production. */
const MIN_PROD_JWT_SECRET_LENGTH = 32;
/** Minimum admin-grant-token length we accept in production. */
const MIN_PROD_ADMIN_TOKEN_LENGTH = 16;

const EnvSchema = z.object({
  // Core services
  DATABASE_URL: z.string().url(),
  REDIS_URL: z.string().url(),

  // MinIO / S3
  MINIO_ROOT_USER: z.string().min(1),
  MINIO_ROOT_PASSWORD: z.string().min(1),
  /** Internal endpoint (host:port) the API talks to, e.g. `minio:9000`. */
  MINIO_ENDPOINT: z.string().min(1),
  /** Public endpoint baked into presigned URLs handed to the browser. */
  MINIO_PUBLIC_ENDPOINT: z.string().url(),
  MINIO_BUCKET: z.string().min(1),
  MINIO_USE_SSL: boolish.default("false"),

  // API
  API_PORT: z.coerce.number().int().positive().default(8080),
  /** Comma-separated allowed CORS origins. */
  WEB_ORIGIN: z.string().min(1),
  JWT_SECRET: z.string().min(1),

  // --- Auth (JWT) ---
  /**
   * When true, the API auto-accepts a frictionless "dev-user" identity (no
   * login required) and grants effectively-unlimited credits. Set FALSE in
   * production so missing/invalid tokens are rejected with 401.
   */
  AUTH_DEV_MODE: boolish.default("true"),
  /** `iss` claim baked into minted tokens and verified on inbound tokens. */
  JWT_ISSUER: z.string().min(1).default("aips"),
  /** Token lifetime in seconds (default 30 days). */
  JWT_TTL_SECONDS: z.coerce.number().int().positive().default(2592000),

  // --- Credits / billing ---
  /** Integer credits per US dollar (100 → 1 credit = $0.01). */
  CREDITS_PER_USD: z.coerce.number().int().positive().default(100),
  /** Credits granted on first dev-login so self-host is effectively unlimited. */
  DEV_DEFAULT_CREDITS: z.coerce.number().int().nonnegative().default(1_000_000),
  /** Reservation = estimate × this, to cover under-estimates before settle. */
  CREDIT_SAFETY_MULTIPLIER: z.coerce.number().positive().default(1.5),
  /** Flat credit cost reserved+settled for POST /ai/agent (a cheap text call). */
  SYNC_AGENT_COST_CREDITS: z.coerce.number().int().nonnegative().default(2),
  /** Flat credit cost for POST /ai/analyze-distractions (a vision call). */
  SYNC_DISTRACTIONS_COST_CREDITS: z.coerce
    .number()
    .int()
    .nonnegative()
    .default(5),
  /**
   * Shared secret gating POST /admin/credits/grant (header `x-admin-token`).
   * NO code-level default: REQUIRED in prod (AUTH_DEV_MODE=false). When unset in
   * dev mode it falls back to the well-known placeholder below so the local
   * top-up path keeps working frictionlessly, but the prod guard rejects that
   * placeholder so it can never reach a production boot.
   */
  ADMIN_GRANT_TOKEN: z.string().min(1).optional(),

  // --- Rate limiting ---
  /** Default per-user/per-IP request budget per minute (global). */
  RATE_LIMIT_PER_MIN_DEFAULT: z.coerce.number().int().positive().default(120),
  /** Tighter budget for POST /ai/jobs (it costs money). */
  RATE_LIMIT_AI_JOBS_PER_MIN: z.coerce.number().int().positive().default(20),
  /** Budget for the synchronous /ai/agent + /ai/analyze-distractions calls. */
  RATE_LIMIT_SYNC_PER_MIN: z.coerce.number().int().positive().default(30),
  /** Disable rate limiting entirely (frictionless self-host default). */
  RATE_LIMIT_DEV_DISABLED: boolish.default("true"),

  // --- Stripe (SCAFFOLDING ONLY — inert unless STRIPE_SECRET_KEY is set) ---
  /** When unset, POST /billing/checkout-session returns 501. No real key here. */
  STRIPE_SECRET_KEY: z.string().optional(),

  // AI providers (server-side only — workers consume the keys)
  OPENROUTER_API_KEY: z.string().min(1),
  OPENROUTER_BASE_URL: z.string().url().default("https://openrouter.ai/api/v1"),
  OPENROUTER_IMAGE_MODEL: z
    .string()
    .default("google/gemini-3-pro-image-preview"),
  /** Text/chat model used for agent planning (POST /ai/agent). */
  OPENROUTER_TEXT_MODEL: z.string().default("google/gemini-2.5-flash"),
});

const parsed = EnvSchema.safeParse(process.env);
if (!parsed.success) {
  // Fail fast with a readable report rather than crashing deep in a handler.
  const issues = parsed.error.issues
    .map((i) => `  - ${i.path.join(".") || "(root)"}: ${i.message}`)
    .join("\n");
  // eslint-disable-next-line no-console
  console.error(`Invalid environment configuration:\n${issues}`);
  process.exit(1);
}

const env = parsed.data;

// ---------------------------------------------------------------------------
// Production security guard (fail-fast).
//
// In dev mode (AUTH_DEV_MODE=true, the self-host default) we keep things
// frictionless: an unset ADMIN_GRANT_TOKEN falls back to a well-known
// placeholder and the placeholder JWT_SECRET is tolerated. The MOMENT an
// operator flips AUTH_DEV_MODE=false for production, those known-default secrets
// become an internet-reachable money/privilege hole — so we refuse to boot with
// them. This closes the "dev-mode escape hatch reachable in prod" class for the
// admin-grant token (which has no auth preHandler) and the JWT secret (token
// forgery → account + admin takeover).
// ---------------------------------------------------------------------------
const resolvedAdminGrantToken =
  env.ADMIN_GRANT_TOKEN ?? PLACEHOLDER_ADMIN_GRANT_TOKEN;

if (!env.AUTH_DEV_MODE) {
  const failures: string[] = [];

  // JWT_SECRET: must be set, strong, and not the published placeholder.
  if (
    env.JWT_SECRET === PLACEHOLDER_JWT_SECRET ||
    env.JWT_SECRET.length < MIN_PROD_JWT_SECRET_LENGTH
  ) {
    failures.push(
      `JWT_SECRET is the known placeholder or too short. In production set a ` +
        `random secret of at least ${MIN_PROD_JWT_SECRET_LENGTH} characters ` +
        `(e.g. \`openssl rand -hex 32\`). Anyone who knows the placeholder can ` +
        `forge admin tokens.`,
    );
  }

  // ADMIN_GRANT_TOKEN: must be explicitly set, strong, and not the placeholder.
  // POST /admin/credits/grant has no auth preHandler, so a known token here lets
  // anyone self-fund unlimited paid AI jobs.
  if (env.ADMIN_GRANT_TOKEN === undefined) {
    failures.push(
      `ADMIN_GRANT_TOKEN is unset. It is REQUIRED in production (it gates ` +
        `POST /admin/credits/grant, which mints real-money credits).`,
    );
  } else if (
    env.ADMIN_GRANT_TOKEN === PLACEHOLDER_ADMIN_GRANT_TOKEN ||
    env.ADMIN_GRANT_TOKEN.length < MIN_PROD_ADMIN_TOKEN_LENGTH
  ) {
    failures.push(
      `ADMIN_GRANT_TOKEN is the known placeholder or too short. In production ` +
        `set a random token of at least ${MIN_PROD_ADMIN_TOKEN_LENGTH} ` +
        `characters. The published 'dev-admin-token' would let anyone grant ` +
        `themselves unlimited credits.`,
    );
  }

  if (failures.length > 0) {
    // eslint-disable-next-line no-console
    console.error(
      `FATAL: insecure production configuration (AUTH_DEV_MODE=false):\n` +
        failures.map((f) => `  - ${f}`).join("\n"),
    );
    process.exit(1);
  }
}

export const config = {
  databaseUrl: env.DATABASE_URL,
  redisUrl: env.REDIS_URL,
  minio: {
    accessKey: env.MINIO_ROOT_USER,
    secretKey: env.MINIO_ROOT_PASSWORD,
    endpoint: env.MINIO_ENDPOINT,
    publicEndpoint: env.MINIO_PUBLIC_ENDPOINT,
    bucket: env.MINIO_BUCKET,
    useSsl: env.MINIO_USE_SSL,
  },
  api: {
    port: env.API_PORT,
    /** Parsed list of allowed origins. */
    webOrigins: env.WEB_ORIGIN.split(",").map((o) => o.trim()).filter(Boolean),
    jwtSecret: env.JWT_SECRET,
  },
  auth: {
    devMode: env.AUTH_DEV_MODE,
    jwtIssuer: env.JWT_ISSUER,
    jwtTtlSeconds: env.JWT_TTL_SECONDS,
  },
  credits: {
    creditsPerUsd: env.CREDITS_PER_USD,
    devDefaultCredits: env.DEV_DEFAULT_CREDITS,
    safetyMultiplier: env.CREDIT_SAFETY_MULTIPLIER,
    syncAgentCost: env.SYNC_AGENT_COST_CREDITS,
    syncDistractionsCost: env.SYNC_DISTRACTIONS_COST_CREDITS,
    adminGrantToken: resolvedAdminGrantToken,
  },
  rateLimit: {
    perMinDefault: env.RATE_LIMIT_PER_MIN_DEFAULT,
    aiJobsPerMin: env.RATE_LIMIT_AI_JOBS_PER_MIN,
    syncPerMin: env.RATE_LIMIT_SYNC_PER_MIN,
    devDisabled: env.RATE_LIMIT_DEV_DISABLED,
  },
  stripe: {
    /** Undefined unless a real key is supplied → checkout stays inert. */
    secretKey: env.STRIPE_SECRET_KEY,
  },
  openrouter: {
    apiKey: env.OPENROUTER_API_KEY,
    baseUrl: env.OPENROUTER_BASE_URL,
    imageModel: env.OPENROUTER_IMAGE_MODEL,
    textModel: env.OPENROUTER_TEXT_MODEL,
  },
} as const;

export type Config = typeof config;
