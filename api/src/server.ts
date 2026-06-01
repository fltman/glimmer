/**
 * Fastify application bootstrap.
 *
 * Wires CORS, rate limiting, boot migrations, the always-on credit settle
 * subscriber, the WebSocket relay, and the HTTP routes; exposes /health; and
 * listens on API_PORT bound to 0.0.0.0 (Docker-friendly).
 *
 * Auth: routes that cost money / touch user data carry a `requireAuth`
 * preHandler (registered inside each route plugin). /health and
 * /auth/dev-login stay open. In dev mode auth + rate limiting are frictionless
 * (dev-user is auto-accepted with effectively-unlimited credits).
 */
import Fastify from "fastify";
import cors from "@fastify/cors";
import websocket from "@fastify/websocket";
import { config } from "./config.js";
import { closeRedis } from "./redis.js";
import { migrate } from "./db/migrate.js";
import { closePool } from "./db/pool.js";
import { registerRateLimit } from "./ratelimit.js";
import { startSettleSubscriber } from "./credits/settle-subscriber.js";
import { jobRoutes } from "./jobs/routes.js";
import { agentRoutes } from "./agent/routes.js";
import { distractionRoutes } from "./distractions/routes.js";
import { presignRoutes } from "./storage/presign-routes.js";
import { authRoutes } from "./auth/routes.js";
import { accountRoutes } from "./credits/routes.js";
import { adminRoutes } from "./admin/routes.js";
import { billingRoutes } from "./billing/routes.js";
import { wsRoutes } from "./ws.js";

export async function buildApp() {
  const app = Fastify({
    logger: {
      level: process.env.LOG_LEVEL ?? "info",
      serializers: {
        // The auth token may ride in `?token=` (WS upgrade + presigned <a>
        // links). Fastify logs the full `req.url` (incl. query) by default, so
        // scrub the token value before it lands in logs — otherwise a still-
        // valid 30-day JWT sits in plaintext where anyone with log access could
        // replay it. Mirrors the default req serializer's other fields.
        req(req) {
          return {
            method: req.method,
            url: req.url.replace(/([?&](?:token)=)[^&]*/gi, "$1[redacted]"),
            hostname: req.hostname,
            remoteAddress: req.ip,
            remotePort: req.socket?.remotePort,
          };
        },
      },
    },
  });

  // Boot migrations before anything serves traffic. A DB-down here fails fast
  // (compose already gates the API on a healthy Postgres).
  try {
    await migrate();
    app.log.info("database migrations applied");
  } catch (err) {
    app.log.error({ err }, "FATAL: database migration failed at boot");
    throw err;
  }

  await app.register(cors, {
    origin: config.api.webOrigins,
    credentials: true,
  });

  await registerRateLimit(app);
  await app.register(websocket);

  app.get("/health", { config: { rateLimit: false } }, async () => ({
    ok: true,
  }));

  // Auth (open: /auth/dev-login; protected: /auth/me).
  await app.register(authRoutes);
  // Account / credits reads (protected).
  await app.register(accountRoutes);
  // Admin credit grant (token-gated).
  await app.register(adminRoutes);
  // Stripe scaffolding (inert unless STRIPE_SECRET_KEY set).
  await app.register(billingRoutes);

  // AI routes (all protected via requireAuth in-plugin).
  await app.register(jobRoutes);
  await app.register(agentRoutes);
  await app.register(distractionRoutes);
  await app.register(presignRoutes);
  await app.register(wsRoutes);

  // Always-on credit settlement (independent of any client WS socket).
  const settleSub = startSettleSubscriber(app.log);
  app.addHook("onClose", async () => {
    await settleSub.stop();
  });

  return app;
}

async function main(): Promise<void> {
  const app = await buildApp();

  const shutdown = async (signal: string): Promise<void> => {
    app.log.info({ signal }, "shutting down");
    await app.close();
    await closeRedis();
    await closePool();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));

  try {
    await app.listen({ port: config.api.port, host: "0.0.0.0" });
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }
}

// Run only when executed directly (not when imported by tests).
const isMain =
  process.argv[1] !== undefined &&
  import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  void main();
}
