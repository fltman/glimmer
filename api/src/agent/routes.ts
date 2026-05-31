/**
 * Agent planner route.
 *
 *   POST /ai/agent  — synchronous. Takes an AgentRequest { goal, context? },
 *                     calls the OpenRouter TEXT model to produce an AgentPlan
 *                     (steps drawn from AGENT_OPS, or a clarifying message),
 *                     validates + sanitizes it, and returns { plan } directly.
 *
 * Unlike POST /ai/jobs this does NOT enqueue work — planning is a fast text
 * call and the returned plan is executed client-side by the web app's engine
 * actions and (per-step) AI jobs. The provider key stays server-side.
 */
import type { FastifyPluginAsync } from "fastify";
import type { AgentResponse } from "@aips/shared-types";
import { AgentRequestSchema, RawPlanSchema, coercePlan } from "./schema.js";
import { buildPlannerMessages } from "./prompt.js";
import { chatCompletion, OpenRouterTextError } from "./openrouter-text.js";

/**
 * Extract a JSON object from a model response. Handles the common cases where
 * the model wraps JSON in ```json fences or adds stray prose before/after.
 * Returns the parsed value, or throws on unrecoverable content.
 */
function parseModelJson(text: string): unknown {
  const trimmed = text.trim();

  // Fast path: the whole thing is JSON.
  try {
    return JSON.parse(trimmed);
  } catch {
    // fall through to fence/brace extraction
  }

  // Strip a ```json ... ``` (or bare ``` ... ```) fence if present.
  const fence = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence?.[1]) {
    try {
      return JSON.parse(fence[1].trim());
    } catch {
      // fall through
    }
  }

  // Last resort: slice from the first "{" to the last "}".
  const first = trimmed.indexOf("{");
  const last = trimmed.lastIndexOf("}");
  if (first !== -1 && last > first) {
    return JSON.parse(trimmed.slice(first, last + 1));
  }

  throw new SyntaxError("no JSON object found in model response");
}

export const agentRoutes: FastifyPluginAsync = async (app) => {
  app.post("/ai/agent", async (request, reply) => {
    const parsed = AgentRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply
        .code(400)
        .send({ error: "invalid_request", issues: parsed.error.issues });
    }
    const { goal, context } = parsed.data;

    const messages = buildPlannerMessages(goal, context);

    let raw: string;
    try {
      raw = await chatCompletion(messages);
    } catch (err) {
      if (err instanceof OpenRouterTextError) {
        request.log.warn(
          { code: err.code, msg: err.message },
          "agent planner provider error",
        );
        return reply
          .code(err.status)
          .send({ error: err.code, message: err.message });
      }
      request.log.error({ err }, "agent planner unexpected error");
      return reply
        .code(502)
        .send({ error: "planner_failed", message: "Agent planner failed" });
    }

    // Parse the model's JSON, then validate + sanitize against AGENT_OPS.
    let candidate: unknown;
    try {
      candidate = parseModelJson(raw);
    } catch {
      request.log.warn({ raw: raw.slice(0, 500) }, "planner returned non-JSON");
      return reply.code(502).send({
        error: "planner_bad_output",
        message: "Agent planner did not return valid JSON",
      });
    }

    const rawPlan = RawPlanSchema.safeParse(candidate);
    if (!rawPlan.success) {
      request.log.warn(
        { issues: rawPlan.error.issues },
        "planner JSON did not match plan shape",
      );
      return reply.code(502).send({
        error: "planner_bad_output",
        message: "Agent planner returned a malformed plan",
      });
    }

    const { plan, droppedOps } = coercePlan(rawPlan.data);
    if (droppedOps.length > 0) {
      request.log.info({ droppedOps }, "dropped unknown ops from agent plan");
    }

    const response: AgentResponse = { plan };
    return reply.send(response);
  });
};
