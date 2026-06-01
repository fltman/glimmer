/**
 * Auth routes.
 *
 *   POST /auth/dev-login  — DEV/self-host only. Mints a 30-day token for the
 *       given userId (default "dev-user"), ensures the user exists, and grants
 *       DEV_DEFAULT_CREDITS on first login (balance 0 → effectively unlimited).
 *       Returns 403 when AUTH_DEV_MODE is off. This is the frictionless
 *       "auto-issue a dev identity" path — no credentials required.
 *   GET  /auth/me         — requireAuth. Returns {userId, isAdmin, balanceCredits}.
 *   POST /auth/login      — real production login. Stubbed 501 for now (the
 *       shape exists so the web can wire it; real credential flow is future).
 */
import type { FastifyPluginAsync } from "fastify";
import type {
  DevLoginResponse,
  MeResponse,
} from "@aips/shared-types";
import { z } from "zod";
import { config } from "../config.js";
import { getAuth, requireAuth, DEFAULT_DEV_USER } from "../auth.js";
import { signToken } from "./jwt.js";
import { ensureUser, getBalance, grant, isAdminUser } from "../credits/ledger.js";

const DevLoginBody = z.object({
  userId: z.string().min(1).max(128).optional(),
});

export const authRoutes: FastifyPluginAsync = async (app) => {
  app.post("/auth/dev-login", async (request, reply) => {
    if (!config.auth.devMode) {
      return reply.code(403).send({
        error: "forbidden",
        message: "Dev login is disabled (AUTH_DEV_MODE=false)",
      });
    }
    const parsed = DevLoginBody.safeParse(request.body ?? {});
    if (!parsed.success) {
      return reply
        .code(400)
        .send({ error: "invalid_request", issues: parsed.error.issues });
    }
    const userId = parsed.data.userId ?? DEFAULT_DEV_USER;

    // In dev mode the self-host user is the operator: flag them admin so their
    // bearer JWT alone authorizes the dev credit top-up (POST /admin/credits/
    // grant), with NO admin secret shipped to the browser. ensureUser upgrades
    // the flag even if a prior reserve()/grant() already created the row.
    await ensureUser(userId, { isAdmin: true });
    // First-login bonus: grant the dev allowance only when the balance is 0 so
    // re-logging-in doesn't keep topping up.
    let balance = await getBalance(userId);
    if (balance === 0 && config.credits.devDefaultCredits > 0) {
      balance = await grant(
        userId,
        config.credits.devDefaultCredits,
        "dev first-login grant",
      );
    }

    const { token, expiresAt } = signToken(userId, {
      isAdmin: await isAdminUser(userId),
    });
    const body: DevLoginResponse = {
      token,
      userId,
      expiresAt,
      balanceCredits: balance,
    };
    return reply.send(body);
  });

  app.get("/auth/me", { preHandler: requireAuth }, async (request, reply) => {
    const auth = getAuth(request);
    const body: MeResponse = {
      userId: auth.userId,
      isAdmin: auth.isAdmin,
      balanceCredits: await getBalance(auth.userId),
    };
    return reply.send(body);
  });

  // Production credential login is out of scope here — the shape exists so the
  // web client can branch on dev vs prod without a 404.
  app.post("/auth/login", async (_request, reply) => {
    return reply.code(501).send({
      error: "not_implemented",
      message: "Production login is not implemented yet; use dev mode.",
    });
  });
};
