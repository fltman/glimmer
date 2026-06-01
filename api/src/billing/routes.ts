/**
 * Billing routes — Stripe SCAFFOLDING ONLY.
 *
 *   GET  /billing/packs              — static credit-pack catalog + whether
 *                                      Stripe is configured.
 *   POST /billing/checkout-session   — requireAuth. INERT unless
 *                                      STRIPE_SECRET_KEY is set: returns 501
 *                                      `stripe_not_configured` otherwise. NO
 *                                      real card/Stripe credentials are wired
 *                                      here; this only proves the endpoint
 *                                      shape so a future integration drops in
 *                                      without touching the web client.
 *
 * Real credit top-ups in dev/testing happen via POST /admin/credits/grant, not
 * here. When a real Stripe key is supplied, the actual session-creation call +
 * webhook-driven credit grant are the future work — intentionally not built.
 */
import type { FastifyPluginAsync } from "fastify";
import type {
  BillingPacksResponse,
  CreditPack,
} from "@aips/shared-types";
import { z } from "zod";
import { config } from "../config.js";
import { requireAuth } from "../auth.js";

/** Static credit packs. priceUsd × CREDITS_PER_USD ≈ credits (rounded for UX). */
const CREDIT_PACKS: CreditPack[] = [
  { id: "starter", credits: 1000, priceUsd: 10, label: "Starter — 1,000 credits" },
  { id: "pro", credits: 5500, priceUsd: 50, label: "Pro — 5,500 credits" },
  { id: "studio", credits: 12000, priceUsd: 100, label: "Studio — 12,000 credits" },
];

const CheckoutBody = z.object({
  packId: z.string().min(1),
  successUrl: z.string().url().optional(),
  cancelUrl: z.string().url().optional(),
});

export const billingRoutes: FastifyPluginAsync = async (app) => {
  app.get("/billing/packs", async (_request, reply) => {
    const body: BillingPacksResponse = {
      packs: CREDIT_PACKS,
      stripeEnabled: Boolean(config.stripe.secretKey),
    };
    return reply.send(body);
  });

  app.post(
    "/billing/checkout-session",
    { preHandler: requireAuth },
    async (request, reply) => {
      const parsed = CheckoutBody.safeParse(request.body);
      if (!parsed.success) {
        return reply
          .code(400)
          .send({ error: "invalid_request", issues: parsed.error.issues });
      }
      const pack = CREDIT_PACKS.find((p) => p.id === parsed.data.packId);
      if (!pack) {
        return reply
          .code(404)
          .send({ error: "not_found", message: "Unknown credit pack" });
      }

      // Inert path: no real key → no checkout. This is scaffolding only.
      if (!config.stripe.secretKey) {
        return reply.code(501).send({
          error: "stripe_not_configured",
          message:
            "Stripe is not configured. Set STRIPE_SECRET_KEY to enable checkout. " +
            "For dev/testing, grant credits via POST /admin/credits/grant.",
        });
      }

      // A real Stripe integration would create a Checkout Session here and
      // return its hosted URL. Intentionally NOT implemented (no real card/
      // Stripe credentials are entered in this project).
      return reply.code(501).send({
        error: "stripe_not_configured",
        message: "Stripe checkout session creation is not implemented yet.",
      });
    },
  );
};
