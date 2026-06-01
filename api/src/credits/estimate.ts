/**
 * Per-capability credit estimates (pre-enqueue reservation basis).
 *
 * These are the STARTING estimate (in credits) for each capability. The actual
 * reservation is `estimate × CREDIT_SAFETY_MULTIPLIER` (rounded up) to cover
 * under-estimates; settle later refunds the difference against the real
 * provider cost. At CREDITS_PER_USD=100 (1 credit = $0.01) an estimate of 6 ≈
 * $0.06 — roughly a Gemini image-gen call. Tune against real usage.cost values
 * once jobs have run.
 *
 * Notes per capability:
 *  - remove_background = 0: the client-preferred path returns a directive and
 *    never enqueues (no provider charge). The server fallback, if ever taken,
 *    settles against its real cost.
 *  - segment / color_match = 1: no generative provider cost (fal/replicate
 *    segment has no usage.cost; color_match is pure local numpy). The small
 *    reserve keeps every job in the ledger; settle refunds back to ~0.
 *  - upscale = 10: base resample + a possible creative-enhance Gemini pass.
 */
import type { Capability } from "@aips/shared-types";
import { config } from "../config.js";

/** Estimated credits per capability (before the safety multiplier). */
export const CAPABILITY_COST_CREDITS: Record<Capability, number> = {
  text_to_image: 6,
  image_edit: 6,
  inpaint: 6,
  outpaint: 8,
  harmonize: 6,
  relight: 6,
  remove_reflections: 6,
  upscale: 10,
  segment: 1,
  color_match: 1,
  remove_background: 0,
};

/**
 * Credits to RESERVE before enqueuing a job of this capability.
 * = ceil(estimate × CREDIT_SAFETY_MULTIPLIER). Never below the raw estimate.
 */
export function reserveCreditsFor(capability: Capability): number {
  const base = CAPABILITY_COST_CREDITS[capability];
  return Math.ceil(base * config.credits.safetyMultiplier);
}

/** Convert a raw USD provider cost to billed credits (rounded up). */
export function usdToCredits(usd: number): number {
  return Math.ceil(usd * config.credits.creditsPerUsd);
}
