/**
 * Zod schemas for the agent planner endpoint (POST /ai/agent).
 *
 * Two distinct schemas live here:
 *  - `AgentRequestSchema` gates the inbound HTTP body.
 *  - `AgentPlanSchema` validates the JSON the LLM returns. Unknown ops are
 *    dropped (not rejected) so a single hallucinated step doesn't sink an
 *    otherwise-usable plan — see `coercePlan`.
 *
 * The op vocabulary is the single source of truth in @aips/shared-types
 * (AGENT_OPS / AGENT_OP_NAMES); we validate against it here rather than
 * re-listing op names.
 */
import { z } from "zod";
import {
  AGENT_OP_NAMES,
  type AgentPlan,
  type AgentStep,
} from "@aips/shared-types";

/** Inbound request body for POST /ai/agent. */
export const AgentRequestSchema = z.object({
  goal: z.string().min(1).max(4000),
  context: z
    .object({
      layers: z.number().int().nonnegative().optional(),
      hasSelection: z.boolean().optional(),
      activeLayerKind: z.string().max(64).optional(),
    })
    .optional(),
});

export type AgentRequestBody = z.infer<typeof AgentRequestSchema>;

/**
 * A single step as emitted by the model. `op` is validated loosely here (any
 * string) so the parse doesn't fail on an unknown op; filtering to the known
 * vocabulary happens in `coercePlan`, which is lossy-by-design.
 *
 * Everything below is tolerant-by-design: the model is an LLM, so a single
 * malformed field must NOT sink the whole plan.
 *  - `params` coerces any non-object value (null, string, array, number) to {}
 *    rather than rejecting — the executor passes params through opaquely and is
 *    already defensive per-op, so {} (engine defaults) is the safe fallback.
 *  - `rationale` falls back to undefined if it isn't a clean string.
 *  - A step whose `op` isn't even a string degrades to a sentinel op that
 *    `coercePlan` then drops (rather than failing the array parse).
 */
const ParamsSchema = z
  .record(z.unknown())
  .catch({}) // null / array / string / number / parse error → {}
  .default({});

const RawStepSchema = z
  .object({
    op: z.string().catch("__invalid__"),
    // Default to {} when the model omits params (e.g. for select_all / deselect).
    params: ParamsSchema,
    rationale: z.string().max(2000).optional().catch(undefined),
  })
  // A wholly malformed step object (e.g. a bare string in the array) becomes a
  // droppable sentinel rather than failing the whole plan parse.
  .catch({ op: "__invalid__", params: {}, rationale: undefined });

/** The raw plan shape we expect the model to return as JSON. */
export const RawPlanSchema = z.object({
  // Tolerate a missing/garbled `steps` (→ []) so a clarifying-message-only
  // response (or a slightly malformed one) still parses.
  steps: z.array(RawStepSchema).catch([]).default([]),
  message: z.string().max(4000).optional().catch(undefined),
});

export type RawPlan = z.infer<typeof RawPlanSchema>;

const KNOWN_OPS = new Set<string>(AGENT_OP_NAMES);

/**
 * Validate + sanitize the model's raw plan into a wire-safe AgentPlan:
 *  - drops any step whose `op` is not in AGENT_OPS,
 *  - guarantees `params` is an object,
 *  - preserves `message` (used for clarifying questions / summaries).
 *
 * Returns the cleaned plan and how many unknown steps were dropped (for logs).
 */
export function coercePlan(raw: RawPlan): {
  plan: AgentPlan;
  droppedOps: string[];
} {
  const droppedOps: string[] = [];
  const steps: AgentStep[] = [];

  for (const s of raw.steps) {
    if (!KNOWN_OPS.has(s.op)) {
      droppedOps.push(s.op);
      continue;
    }
    steps.push({
      op: s.op,
      params: s.params ?? {},
      ...(s.rationale ? { rationale: s.rationale } : {}),
    });
  }

  const plan: AgentPlan = {
    steps,
    ...(raw.message ? { message: raw.message } : {}),
  };
  return { plan, droppedOps };
}
