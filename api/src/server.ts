/**
 * Fastify application bootstrap.
 *
 * Wires CORS, the WebSocket relay, and the HTTP routes; exposes /health; and
 * listens on API_PORT bound to 0.0.0.0 (Docker-friendly).
 */
import Fastify from "fastify";
import cors from "@fastify/cors";
import websocket from "@fastify/websocket";
import { config } from "./config.js";
import { closeRedis } from "./redis.js";
import { jobRoutes } from "./jobs/routes.js";
import { presignRoutes } from "./storage/presign-routes.js";
import { wsRoutes } from "./ws.js";

export async function buildApp() {
  const app = Fastify({
    logger: { level: process.env.LOG_LEVEL ?? "info" },
  });

  await app.register(cors, {
    origin: config.api.webOrigins,
    credentials: true,
  });

  await app.register(websocket);

  app.get("/health", async () => ({ ok: true }));

  // Routes
  await app.register(jobRoutes);
  await app.register(presignRoutes);
  await app.register(wsRoutes);

  return app;
}

async function main(): Promise<void> {
  const app = await buildApp();

  const shutdown = async (signal: string): Promise<void> => {
    app.log.info({ signal }, "shutting down");
    await app.close();
    await closeRedis();
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
