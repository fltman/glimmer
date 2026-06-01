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
import { extractToken, DEFAULT_DEV_USER } from "./auth.js";
import { verifyToken } from "./auth/jwt.js";

/** WebSocket close code for "unauthorized" (per the 4000-4999 app range). */
const WS_CLOSE_UNAUTHORIZED = 4401;

export const wsRoutes: FastifyPluginAsync = async (app) => {
  app.get("/ws", { websocket: true }, (socket, request) => {
    // --- Auth gate. The browser WebSocket API can't set an Authorization
    //     header, so the token rides on the upgrade URL as `?token=<jwt>`.
    //     Mirrors getAuth(): a present-but-invalid token always closes; NO
    //     token closes in prod but is accepted as dev-user in dev mode. ---
    const raw = extractToken(request);
    const claims = raw ? verifyToken(raw) : null;
    if (raw && !claims) {
      // Present-but-invalid token → reject regardless of mode.
      socket.close(WS_CLOSE_UNAUTHORIZED, "unauthorized");
      return;
    }
    if (!claims && !config.auth.devMode) {
      // No token in prod → reject.
      socket.close(WS_CLOSE_UNAUTHORIZED, "unauthorized");
      return;
    }
    const userId = claims?.userId ?? DEFAULT_DEV_USER;

    // One dedicated subscriber per socket (a subscribing connection can't run
    // normal commands, and we want clean per-connection teardown).
    const sub = new Redis(config.redisUrl, { maxRetriesPerRequest: null });
    /**
     * channel -> jobId for channels this socket is subscribed to. A channel is
     * present here ONLY after its ownership was verified against `userId` (or
     * deferred to a first-message re-check for a not-yet-stored job). The relay
     * uses this map both to ignore stray channels and to re-key by jobId.
     */
    const subscribed = new Map<string, string>();
    /**
     * jobIds whose ownership is NOT yet verified because the job wasn't stored
     * at subscribe time. The relay re-verifies ownership on the FIRST message
     * for these before forwarding anything, then clears the entry.
     */
    const pendingVerify = new Set<string>();

    const send = (msg: ServerWsMessage): void => {
      if (socket.readyState === socket.OPEN) {
        socket.send(JSON.stringify(msg));
      }
    };

    /**
     * True iff `ownerId` (the job's stored userId) is owned by this socket.
     * A falsy/empty owner is treated as a NON-match (deny) rather than skipped,
     * so a userId-less job is never world-readable — except in dev mode, where
     * everyone collapses to the single dev-user and there is no cross-user data.
     */
    const ownedByThisSocket = (ownerId: string | undefined | null): boolean => {
      if (config.auth.devMode) return true;
      return typeof ownerId === "string" && ownerId.length > 0 && ownerId === userId;
    };

    // Relay every Redis message for subscribed channels to this socket — but
    // ONLY after a per-message ownership check, so the streamed relay can never
    // leak another user's job_update (which carries presigned artifact URLs).
    // Workers publish a FULL ServerWsMessage envelope ({type:"job_update", job})
    // onto the channel, so forward it verbatim. (Re-wrapping it here was the
    // double-nesting bug that hid every worker progress/success update behind
    // an extra {type:"job_update", job:{...}} layer.) For robustness we also
    // accept a bare Job payload and wrap that.
    sub.on("message", (channel, message) => {
      const jobId = subscribed.get(channel);
      if (jobId === undefined) return; // not (or no longer) ours — ignore.
      void relay(jobId, message);
    });

    /**
     * Forward one published message after re-confirming ownership. For a job
     * that wasn't stored at subscribe time we re-read its authoritative owner
     * here (the publish/store may have just landed) and refuse if it isn't ours.
     */
    const relay = async (jobId: string, message: string): Promise<void> => {
      // Re-verify ownership on the message stream, not just at subscribe time.
      if (pendingVerify.has(jobId)) {
        const stored = await getJob(jobId);
        if (stored && !ownedByThisSocket(stored.userId)) {
          // Someone else's job materialised on a channel we optimistically
          // subscribed to — drop the subscription and never forward it.
          await unsubscribe(jobId).catch(() => undefined);
          return;
        }
        // Once a store exists with a matching (or dev) owner, trust the channel.
        if (stored) pendingVerify.delete(jobId);
      }
      let parsed: Record<string, unknown>;
      try {
        parsed = JSON.parse(message) as Record<string, unknown>;
      } catch {
        // Ignore malformed publishes rather than killing the socket.
        return;
      }
      // Defence-in-depth: if the payload itself carries a userId, it must match.
      const job =
        parsed && parsed.type === "job_update" && parsed.job
          ? (parsed.job as Record<string, unknown>)
          : parsed && "id" in parsed && "status" in parsed
            ? parsed
            : null;
      if (!job) return; // unknown shape — ignore rather than killing the socket.
      const payloadOwner = (job as { userId?: unknown }).userId;
      if (typeof payloadOwner === "string" && !ownedByThisSocket(payloadOwner)) {
        return;
      }
      if (parsed.type === "job_update" && parsed.job) {
        send(parsed as unknown as ServerWsMessage);
      } else {
        send({ type: "job_update", job: parsed as unknown as Job });
      }
    };

    const subscribe = async (jobId: string): Promise<void> => {
      // Ownership: a socket may only watch its OWN jobs. job_update payloads
      // carry presigned artifact URLs, so the WS path must enforce the same
      // ownership the HTTP GET /ai/jobs/:id does. A mismatch is reported as
      // not_found (don't reveal that someone else's job exists) and no channel
      // subscription is created.
      const stored = await getJob(jobId);
      if (stored && !ownedByThisSocket(stored.userId)) {
        send({
          type: "error",
          jobId,
          code: "not_found",
          message: "Job not found",
        });
        return;
      }
      // Not-yet-stored job: in PROD refuse outright (an authenticated user can't
      // prove ownership of a job that doesn't exist yet, and jobIds are private
      // server-minted nanoids). In DEV mode everyone is the single dev-user, so
      // allow it and re-verify on the first relayed message once it's stored.
      if (!stored) {
        if (!config.auth.devMode) {
          send({
            type: "error",
            jobId,
            code: "not_found",
            message: "Job not found",
          });
          return;
        }
        pendingVerify.add(jobId);
      }
      const channel = jobChannel(jobId);
      if (!subscribed.has(channel)) {
        await sub.subscribe(channel);
        subscribed.set(channel, jobId);
      }
      // Immediate re-sync: push current stored state if the job exists.
      if (stored) {
        send({ type: "job_update", job: stored.job });
      }
    };

    const unsubscribe = async (jobId: string): Promise<void> => {
      const channel = jobChannel(jobId);
      pendingVerify.delete(jobId);
      if (subscribed.delete(channel)) {
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
      pendingVerify.clear();
    };
    socket.on("close", cleanup);
    socket.on("error", cleanup);
  });
};
