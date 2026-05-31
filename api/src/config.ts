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

  // AI providers (server-side only — workers consume the keys)
  OPENROUTER_API_KEY: z.string().min(1),
  OPENROUTER_BASE_URL: z.string().url().default("https://openrouter.ai/api/v1"),
  OPENROUTER_IMAGE_MODEL: z
    .string()
    .default("google/gemini-3-pro-image-preview"),
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
  openrouter: {
    apiKey: env.OPENROUTER_API_KEY,
    baseUrl: env.OPENROUTER_BASE_URL,
    imageModel: env.OPENROUTER_IMAGE_MODEL,
  },
} as const;

export type Config = typeof config;
