/**
 * Admin routes — dev/testing credit top-up.
 *
 *   POST /admin/credits/grant {userId, credits, reason?}
 *     Gated by the `x-admin-token` header (=== ADMIN_GRANT_TOKEN, DEV MODE ONLY)
 *     OR an authenticated admin JWT (isAdmin claim). Used to top up a user's
 *     balance for testing. In PRODUCTION (AUTH_DEV_MODE=false) the header path
 *     is disabled entirely — only a real admin JWT authorizes a grant — and the
 *     config boot guard refuses to start with the published placeholder token.
 *     The literal 'dev-admin-token' placeholder is never accepted in any mode.
 *     This is the dev/admin grant path the plan calls for — there is NO real
 *     payment processing here.
 */
import type { FastifyPluginAsync } from "fastify";
import type { GrantCreditsResponse } from "@aips/shared-types";
import { z } from "zod";
import { config, PLACEHOLDER_ADMIN_GRANT_TOKEN } from "../config.js";
import { getAuth } from "../auth.js";
import { grant } from "../credits/ledger.js";

const GrantBody = z.object({
  userId: z.string().min(1).max(128),
  credits: z.number().int(),
  reason: z.string().max(256).optional(),
});

export const adminRoutes: FastifyPluginAsync = async (app) => {
  app.post("/admin/credits/grant", async (request, reply) => {
    // Authorize: a matching admin token header (DEV MODE ONLY), or an admin JWT.
    //
    // Defense-in-depth on top of the config.ts boot guard:
    //  - The shared-header path is accepted ONLY in dev mode. In production the
    //    only way in is a real admin JWT, so a leaked/guessed token can't grant
    //    money even if the boot guard were somehow bypassed.
    //  - The published placeholder 'dev-admin-token' is NEVER accepted, in any
    //    mode, so it can't authorize a grant by accident.
    const headerToken = request.headers["x-admin-token"];
    const tokenOk =
      config.auth.devMode &&
      typeof headerToken === "string" &&
      headerToken.length > 0 &&
      headerToken !== PLACEHOLDER_ADMIN_GRANT_TOKEN &&
      headerToken === config.credits.adminGrantToken;

    let jwtAdmin = false;
    try {
      jwtAdmin = getAuth(request).isAdmin;
    } catch {
      jwtAdmin = false; // unauthenticated — fine, fall back to the token check
    }

    if (!tokenOk && !jwtAdmin) {
      return reply
        .code(403)
        .send({ error: "forbidden", message: "Admin token required" });
    }

    const parsed = GrantBody.safeParse(request.body);
    if (!parsed.success) {
      return reply
        .code(400)
        .send({ error: "invalid_request", issues: parsed.error.issues });
    }
    const { userId, credits, reason } = parsed.data;
    const balanceCredits = await grant(userId, credits, reason ?? "admin grant");
    const body: GrantCreditsResponse = { userId, balanceCredits };
    return reply.send(body);
  });
};
