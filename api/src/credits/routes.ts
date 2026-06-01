/**
 * Account / credits read routes (all require auth).
 *
 *   GET /account          — {userId, isAdmin, balanceCredits, usage[]} (one-shot).
 *   GET /account/balance  — {userId, balanceCredits} (lightweight poll).
 *   GET /account/usage    — {usage[]} (recent billed rows).
 *
 * The web client reads the live balance after each job to refresh its credit
 * meter; usage backs a billing/history view.
 */
import type { FastifyPluginAsync } from "fastify";
import type {
  AccountResponse,
  BalanceResponse,
  UsageResponse,
} from "@aips/shared-types";
import { getAuth, requireAuth } from "../auth.js";
import { getBalance, getUsage } from "./ledger.js";

export const accountRoutes: FastifyPluginAsync = async (app) => {
  app.get("/account", { preHandler: requireAuth }, async (request, reply) => {
    const { userId, isAdmin } = getAuth(request);
    const [balanceCredits, usage] = await Promise.all([
      getBalance(userId),
      getUsage(userId, 50),
    ]);
    const body: AccountResponse = { userId, isAdmin, balanceCredits, usage };
    return reply.send(body);
  });

  app.get(
    "/account/balance",
    { preHandler: requireAuth },
    async (request, reply) => {
      const { userId } = getAuth(request);
      const body: BalanceResponse = {
        userId,
        balanceCredits: await getBalance(userId),
      };
      return reply.send(body);
    },
  );

  app.get(
    "/account/usage",
    { preHandler: requireAuth },
    async (request, reply) => {
      const { userId } = getAuth(request);
      const body: UsageResponse = { usage: await getUsage(userId, 100) };
      return reply.send(body);
    },
  );
};
