/**
 * System/user prompt construction for the agent planner.
 *
 * The system prompt is generated FROM `AGENT_OPS` so the LLM and the web
 * executor stay in lockstep — there is no second, drifting copy of the op
 * list. The user message carries the goal plus the current editor context.
 */
import { AGENT_OPS, type AgentContext } from "@aips/shared-types";
import type { ChatMessage } from "./openrouter-text.js";

/** Render the op vocabulary as a compact, LLM-readable reference. */
function renderOpsReference(): string {
  return AGENT_OPS.map((op) => {
    const params =
      op.params.length === 0
        ? "    (no params)"
        : op.params
            .map((p) => {
              const enumPart = p.enum
                ? ` — one of: ${p.enum.join(", ")}`
                : "";
              return `    - ${p.name} (${p.type}): ${p.description}${enumPart}`;
            })
            .join("\n");
    return `- ${op.op}: ${op.description}\n${params}`;
  }).join("\n\n");
}

function renderContext(ctx: AgentContext | undefined): string {
  if (!ctx) return "No editor context was provided.";
  const lines: string[] = [];
  if (typeof ctx.layers === "number") lines.push(`- layers: ${ctx.layers}`);
  if (typeof ctx.hasSelection === "boolean")
    lines.push(`- hasSelection: ${ctx.hasSelection}`);
  if (ctx.activeLayerKind)
    lines.push(`- activeLayerKind: ${ctx.activeLayerKind}`);
  return lines.length > 0 ? lines.join("\n") : "No editor context was provided.";
}

const SYSTEM_PREAMBLE = `You are the planning brain of an AI-first web image editor (a modern, browser-based Photoshop). The user states a goal in natural language; you translate it into a concrete, ordered PLAN of editor operations that a deterministic executor will run.

You can ONLY use the operations listed below ("ops"). Each step references one op by its exact name and supplies concrete params for it. Do not invent ops, params, or values that are not described.

Guidelines:
- Order steps the way an expert retoucher would (e.g. select before inpaint; remove background before adding a drop shadow).
- Use the editor's native ops (add_adjustment, apply_filter, add_layer_effect, fill, selection ops) for things they can express. Reserve image_edit_composite and generate_layer for content-aware changes that ops cannot express.
- inpaint_selection requires an active selection. If context.hasSelection is false and the goal needs a selection, either add a selection-establishing step you CAN express, or ask for clarification instead.
- Colors are #RRGGBB or #RRGGBBAA hex strings.
- For params you are unsure about, send an empty object {} to use the editor's sensible defaults rather than guessing exotic numbers.
- If the goal is ambiguous, contradictory, or impossible with the available ops, return an empty "steps" array and put a short clarifying question in "message".
- Keep "rationale" on each step to one short sentence (optional).

OUTPUT FORMAT — return ONLY a single JSON object, no markdown, no prose around it:
{
  "steps": [ { "op": "<op name>", "params": { ... }, "rationale": "<optional>" } ],
  "message": "<optional clarifying question or short summary of the plan>"
}`;

/** Build the [system, user] messages for a planning request. */
export function buildPlannerMessages(
  goal: string,
  context: AgentContext | undefined,
): ChatMessage[] {
  const system = `${SYSTEM_PREAMBLE}

AVAILABLE OPS:
${renderOpsReference()}`;

  const user = `CURRENT EDITOR CONTEXT:
${renderContext(context)}

USER GOAL:
${goal}

Return the JSON plan now.`;

  return [
    { role: "system", content: system },
    { role: "user", content: user },
  ];
}
