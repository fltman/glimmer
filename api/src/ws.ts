/**
 * WebSocket progress relay — GET /ws.
 *
 * Protocol (see @aips/shared-types):
 *   client → { type:"subscribe", jobId }   : start relaying that job
 *           { type:"unsubscribe", jobId }   : stop
 *           { type:"ping" }                 : keepalive → server replies pong
 *   server → { type:"job_update", job }     : forwarded from Redis pub/sub
 *           { type:"error", ... }
 *           { type:"pong" }
 *
 * Workers PUBLISH job state onto `job:<id>` (jobChannel). Each socket owns a
 * dedicated ioredis subscriber connection so subscriptions are isolated and
 * torn down cleanly on close. On subscribe we immediately push the current
 * stored job state so a late subscriber re-syncs (matches GET /ai/jobs/:id).
 */
import type { FastifyPluginAsync } from "fastify";
import { Redis } from "ioredis";
import type {
  ClientWsMessage,
  Job,
  ServerWsMessage,
} from "@aips/shared-types";
import { jobChannel } from "@aips/shared-types";
import { config } from "./config.js";
import { getJob } from "./jobs/store.js";

export const wsRoutes: FastifyPluginAsync = async (app) => {
  app.get("/ws", { websocket: true }, (socket) => {
    // One dedicated subscriber per socket (a subscribing connection can't run
    // normal commands, and we want clean per-connection teardown).
    const sub = new Redis(config.redisUrl, { maxRetriesPerRequest: null });
    /** jobId -> channel currently subscribed for this socket. */
    const subscribed = new Set<string>();

    const send = (msg: ServerWsMessage): void => {
      if (socket.readyState === socket.OPEN) {
        socket.send(JSON.stringify(msg));
      }
    };

    // Relay every Redis message for subscribed channels to this socket.
    // Workers publish a FULL ServerWsMessage envelope ({type:"job_update", job})
    // onto the channel, so forward it verbatim. (Re-wrapping it here was the
    // double-nesting bug that hid every worker progress/success update behind
    // an extra {type:"job_update", job:{...}} layer.) For robustness we also
    // accept a bare Job payload and wrap that.
    sub.on("message", (_channel, message) => {
      try {
        const parsed = JSON.parse(message) as Record<string, unknown>;
        if (parsed && parsed.type === "job_update" && parsed.job) {
          send(parsed as unknown as ServerWsMessage);
        } else if (parsed && "id" in parsed && "status" in parsed) {
          send({ type: "job_update", job: parsed as unknown as Job });
        }
        // else: unknown shape — ignore rather than killing the socket.
      } catch {
        // Ignore malformed publishes rather than killing the socket.
      }
    });

    const subscribe = async (jobId: string): Promise<void> => {
      const channel = jobChannel(jobId);
      if (!subscribed.has(jobId)) {
        await sub.subscribe(channel);
        subscribed.add(jobId);
      }
      // Immediate re-sync: push current stored state if the job exists.
      const stored = await getJob(jobId);
      if (stored) {
        send({ type: "job_update", job: stored.job });
      }
    };

    const unsubscribe = async (jobId: string): Promise<void> => {
      const channel = jobChannel(jobId);
      if (subscribed.delete(jobId)) {
        await sub.unsubscribe(channel);
      }
    };

    socket.on("message", (raw: Buffer) => {
      let msg: ClientWsMessage;
      try {
        msg = JSON.parse(raw.toString()) as ClientWsMessage;
      } catch {
        send({ type: "error", code: "bad_message", message: "Invalid JSON" });
        return;
      }

      switch (msg.type) {
        case "subscribe":
          void subscribe(msg.jobId).catch(() =>
            send({
              type: "error",
              jobId: msg.jobId,
              code: "subscribe_failed",
              message: "Could not subscribe to job",
            }),
          );
          break;
        case "unsubscribe":
          void unsubscribe(msg.jobId);
          break;
        case "ping":
          send({ type: "pong" });
          break;
        default:
          send({
            type: "error",
            code: "unknown_type",
            message: "Unknown message type",
          });
      }
    });

    const cleanup = (): void => {
      void sub.quit();
      subscribed.clear();
    };
    socket.on("close", cleanup);
    socket.on("error", cleanup);
  });
};
