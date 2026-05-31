/**
 * ASSISTANT — a conversational surface over the editor. Three intents, one chat:
 *
 *  1. CONVERSATIONAL EDITING (default). A free-form instruction edits the whole
 *     visible image: export the composite PNG → presign-upload → image_edit job
 *     → drop the result as a NEW layer (non-destructive). "Make the sky pink",
 *     "give it a 70s film look".
 *
 *  2. PROMPT-TO-LAYER. An additive request ("Add a …", "Generate a …") runs
 *     text_to_image and places the result as a new layer.
 *
 *  3. AUTO-EDIT (toggle, or a leading "make it …" verb). Calls POST /ai/agent
 *     with {goal, context}, SHOWS the planned steps, then runs them via
 *     executePlan() — streaming "Adding Curves… Applied vignette… done" into the
 *     chat. The planner may also answer with a clarifying question (no steps).
 *
 * IMPLEMENTATION NOTE — all three intents run through the SAME canonical agent
 * executor in `web/src/ai/agent` (executor + helpers + agentClient). Intents 1
 * and 2 are just single-step plans (image_edit_composite / generate_layer). This
 * means the panel has exactly one code path for running editor work, and inherits
 * the executor's failure-aware job runner (a failed AI job rejects and is
 * reported as a failed step — it is NOT silently treated as success). The earlier
 * duplicate executor/client that lived in this directory has been removed.
 *
 * The assistant always shows its work: the plan it intends to run, and a live
 * per-step trace. The provider key never reaches the browser — we only call our
 * own /ai/agent + the job API, and presigned MinIO URLs.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import type { AgentContext, AgentStep } from "@aips/shared-types";
import { useEngineSnapshot, useHasSelection, setAgentBatching } from "../../state/useEngine";
import {
  requestPlan,
  AgentRequestError,
  executePlan,
  buildExecutorHelpers,
  type AgentPlan,
  type ExecutorHelpers,
  type ProgressEvent as StepProgressEvent,
  type StepResult,
} from "../agent";

// ──────────────────────────────────────────────────────────────
// Chat model
// ──────────────────────────────────────────────────────────────

type Role = "user" | "assistant";

interface PlanView {
  steps: AgentStep[];
  /** Per-step status, parallel to `steps`. */
  status: ("pending" | "running" | "done" | "error")[];
}

interface ChatMessage {
  id: string;
  role: Role;
  text: string;
  /** Assistant-only: a plan being shown/executed inline. */
  plan?: PlanView;
  /** A small inline error tint. */
  tone?: "normal" | "error" | "muted";
}

let _seq = 0;
const nextId = () => `m${Date.now().toString(36)}-${(_seq++).toString(36)}`;

/**
 * Classify a free-form message into an intent when Auto-edit is OFF. Auto-edit
 * forces the planner path regardless. "Add/insert/generate/create a …" → a new
 * generated layer; everything else → a whole-image conversational edit.
 */
function classifyIntent(text: string): "generate" | "edit" {
  return /^\s*(add|insert|generate|create|draw|place|put)\b/i.test(text)
    ? "generate"
    : "edit";
}

/**
 * Heuristic: a leading imperative like "make it …" / "auto …" implies the user
 * wants the multi-step planner even with the toggle off.
 */
function looksLikePlannerVerb(text: string): boolean {
  return /^\s*(make it|auto[- ]?edit|plan|fix|enhance|improve|clean up|retouch)\b/i.test(
    text,
  );
}

/**
 * Disambiguate additive requests: "add a vignette" / "add some film grain" read
 * like prompt-to-layer ("add …"), but the user wants a photographic EFFECT
 * applied — not a generated PICTURE of one. When an additive verb is followed by
 * a known adjustment/filter/effect term, route to the planner instead (it maps
 * to apply_filter / add_adjustment / add_layer_effect). "Add a red bird" has no
 * effect term, so it still goes to text-to-image.
 */
function looksLikeEditEffect(text: string): boolean {
  return (
    /^\s*(add|apply|put|give it|throw in|slap on)\b/i.test(text) &&
    /\b(vignett\w*|grain|noise|blur|gaussian|sharpen|clarity|contrast|brightness|saturat\w*|vibrance|exposure|levels|curves|hue|sepia|black[- ]and[- ]white|b&w|gr[ae]yscale|drop[- ]?shadow|inner[- ]?shadow|outer[- ]?glow|glow|color[- ]?balance|colou?r[- ]?grade|grad(?:e|ing)|chromatic[- ]?aberration|halftone|emboss|posteriz\w*|threshold|gradient[- ]?map|oil[- ]?paint|pixelat\w*|photo[- ]?filter|tint|fade|matte|film[- ]?look)\b/i.test(
      text,
    )
  );
}

/** Title-case-ish humanization of an enum/op token ("hue_saturation" → "Hue Saturation"). */
function humanize(token: string): string {
  return token
    .split(/[_\s]+/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

function asStr(v: unknown, fallback = ""): string {
  return typeof v === "string" ? v : fallback;
}

/** A compact present-tense title for a plan row in the checklist. */
function stepTitle(step: AgentStep): string {
  const p = step.params ?? {};
  switch (step.op) {
    case "add_adjustment":
      return `${humanize(asStr(p.type, "adjustment"))} adjustment`;
    case "apply_filter":
      return `${humanize(asStr(p.type, "filter"))} filter`;
    case "add_layer_effect":
      return `${humanize(asStr(p.type, "effect"))} effect`;
    case "image_edit_composite":
      return `Edit image: "${asStr(p.instruction, "…")}"`;
    case "generate_layer":
      return `Generate: "${asStr(p.prompt, "…")}"`;
    case "remove_background":
      return "Remove background";
    case "inpaint_selection":
      return asStr(p.mode) === "remove"
        ? "Remove selected object"
        : `Fill selection: "${asStr(p.prompt, "…")}"`;
    case "fill":
      return `Fill with ${asStr(p.color, "color")}`;
    case "select_all":
      return "Select all";
    case "deselect":
      return "Clear selection";
    case "invert_selection":
      return "Invert selection";
    case "set_foreground":
      return `Foreground ${asStr(p.color, "color")}`;
    default:
      return humanize(step.op);
  }
}

/** Humanize a job stage for the inline progress line (mirrors AiSectionShell). */
function prettyStage(stage: string): string {
  switch (stage) {
    case "queued":
      return "Queued…";
    case "uploading_input":
      return "Uploading…";
    case "calling_model":
      return "Running model…";
    case "post_processing":
      return "Finishing…";
    case "loading_model":
      return "Loading model…";
    case "done":
      return "Done";
    default:
      return stage || "Working…";
  }
}

// ──────────────────────────────────────────────────────────────
// Panel
// ──────────────────────────────────────────────────────────────

export function AssistantPanel() {
  const snap = useEngineSnapshot();
  const hasSelection = useHasSelection();
  const [input, setInput] = useState("");
  const [autoEdit, setAutoEdit] = useState(false);
  const [messages, setMessages] = useState<ChatMessage[]>([
    {
      id: "intro",
      role: "assistant",
      tone: "muted",
      text:
        "Hi — I'm your editing assistant. Tell me what you want: I'll edit the whole image by chatting (\"make the sky pink\"), generate a new layer (\"add a red bird\"), or — with Auto-edit on — plan a sequence of adjustments and apply them step by step.",
    },
  ]);
  // True while any AI work is in flight (planning, a job, or a plan run).
  const [busy, setBusy] = useState(false);
  // Live AI-job progress (driven by the executor's onJobProgress).
  const [job, setJob] = useState<{ active: boolean; progress: number; stage: string }>(
    { active: false, progress: 0, stage: "" },
  );
  const scrollRef = useRef<HTMLDivElement>(null);

  // Keep the transcript pinned to the latest message.
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages, job.progress, job.stage, job.active]);

  const context = useMemo<AgentContext>(() => {
    const active = snap.layers.find((l) => l.id === snap.activeLayerId);
    return {
      layers: snap.layers.length,
      hasSelection,
      activeLayerKind: active?.kind,
    };
  }, [snap.layers, snap.activeLayerId, hasSelection]);

  // One canonical executor-helpers instance, wired to drive the progress bar.
  // (Rebuilt only if the progress sink identity changes, which it doesn't here.)
  const helpers = useMemo<ExecutorHelpers>(
    () =>
      buildExecutorHelpers({
        onJobProgress: (progress, stage) =>
          setJob({ active: true, progress, stage }),
      }),
    [],
  );

  // ── transcript helpers ──
  function push(msg: Omit<ChatMessage, "id">): string {
    const id = nextId();
    setMessages((prev) => [...prev, { id, ...msg }]);
    return id;
  }
  function patch(id: string, patchFn: (m: ChatMessage) => ChatMessage) {
    setMessages((prev) => prev.map((m) => (m.id === id ? patchFn(m) : m)));
  }

  /**
   * Run a plan (one or many steps), rendering it inline as a live checklist and
   * a final summary. Shared by all three intents — conversational edit and
   * prompt-to-layer build a single-step plan; auto-edit gets the planner's plan.
   */
  async function runPlan(plan: AgentPlan, anchorId: string, summaryNoun: string) {
    const planView: PlanView = {
      steps: plan.steps,
      status: plan.steps.map(() => "pending"),
    };
    patch(anchorId, (m) => ({ ...m, plan: planView }));

    const setStepStatus = (i: number, s: PlanView["status"][number]) =>
      patch(anchorId, (m) =>
        m.plan
          ? {
              ...m,
              plan: {
                ...m.plan,
                status: m.plan.status.map((v, idx) => (idx === i ? s : v)),
              },
            }
          : m,
      );

    const onProgress = (e: StepProgressEvent) => {
      if (e.phase === "start") {
        setStepStatus(e.index, "running");
      } else if (e.result) {
        setStepStatus(e.index, e.result.ok ? "done" : "error");
        if (!e.result.ok) {
          push({ role: "assistant", tone: "error", text: e.result.message });
        }
      }
    };

    setAgentBatching(true);
    try {
      const result = await executePlan(plan, helpers, onProgress);
      const failedSteps = result.results.filter((r: StepResult) => !r.ok);
      if (result.ok) {
        push({
          role: "assistant",
          text:
            result.succeeded === 0
              ? "Nothing to do."
              : `Done — applied ${result.succeeded} ${summaryNoun}${result.succeeded === 1 ? "" : "s"}.`,
        });
      } else if (result.succeeded > 0) {
        push({
          role: "assistant",
          tone: "normal",
          text: `Applied ${result.succeeded} of ${result.results.length} ${summaryNoun}s — ${failedSteps.length} couldn't be applied.`,
        });
      }
      // (When succeeded === 0 the per-step error bubbles above already explain.)
    } finally {
      setAgentBatching(false);
      setJob({ active: false, progress: 0, stage: "" });
    }
  }

  // ── conversational whole-image edit (single-step plan) ──
  async function runConversationalEdit(instruction: string) {
    const id = push({
      role: "assistant",
      text: `Editing the whole image: "${instruction}"…`,
    });
    await runPlan(
      { steps: [{ op: "image_edit_composite", params: { instruction } }] },
      id,
      "edit",
    );
  }

  // ── prompt-to-layer / text-to-image (single-step plan) ──
  async function runGenerateLayer(prompt: string) {
    const id = push({
      role: "assistant",
      text: `Generating a new layer: "${prompt}"…`,
    });
    await runPlan(
      { steps: [{ op: "generate_layer", params: { prompt } }] },
      id,
      "layer",
    );
  }

  // ── auto-edit: plan, show, then execute ──
  async function runAutoEdit(goal: string) {
    const thinkingId = push({ role: "assistant", tone: "muted", text: "Planning…" });
    let plan: AgentPlan;
    try {
      const resp = await requestPlan({ goal, context });
      plan = resp.plan;
    } catch (e) {
      const msg =
        e instanceof AgentRequestError
          ? e.message
          : e instanceof Error
            ? e.message
            : String(e);
      patch(thinkingId, (m) => ({ ...m, tone: "error", text: msg }));
      return;
    }

    // No steps → the planner is asking a question or declining. Show its message.
    if (plan.steps.length === 0) {
      patch(thinkingId, (m) => ({
        ...m,
        tone: "normal",
        text: plan.message ?? "I couldn't turn that into a plan — can you rephrase?",
      }));
      return;
    }

    // Show the plan inline before running it.
    patch(thinkingId, (m) => ({
      ...m,
      tone: "normal",
      text: plan.message
        ? plan.message
        : `Here's my plan (${plan.steps.length} step${plan.steps.length === 1 ? "" : "s"}):`,
    }));

    await runPlan(plan, thinkingId, "step");
  }

  // ── submit ──
  async function onSend() {
    const text = input.trim();
    if (!text || busy) return;
    setInput("");
    push({ role: "user", text });
    setBusy(true);
    setJob({ active: false, progress: 0, stage: "" });
    try {
      if (autoEdit || looksLikePlannerVerb(text) || looksLikeEditEffect(text)) {
        await runAutoEdit(text);
      } else if (classifyIntent(text) === "generate") {
        await runGenerateLayer(text);
      } else {
        await runConversationalEdit(text);
      }
    } catch (e) {
      push({
        role: "assistant",
        tone: "error",
        text: e instanceof Error ? e.message : String(e),
      });
    } finally {
      setBusy(false);
      setJob({ active: false, progress: 0, stage: "" });
    }
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      void onSend();
    }
  }

  return (
    <div className="flex h-full flex-col">
      {/* Mode hint + Auto-edit toggle */}
      <div className="flex items-center justify-between gap-2 border-b border-edge px-1 pb-2">
        <span className="text-[10px] leading-tight text-muted/70">
          {autoEdit
            ? "Auto-edit: I'll plan adjustments & filters and apply them."
            : "Chat to edit the whole image, or say \"add a …\" to generate a layer."}
        </span>
        <button
          type="button"
          onClick={() => setAutoEdit((v) => !v)}
          className={`flex-none rounded-md px-2 py-1 text-[10px] font-semibold uppercase tracking-wide transition-colors ${
            autoEdit
              ? "bg-accent text-white"
              : "border border-edge text-muted hover:bg-panelraised hover:text-ink"
          }`}
          title="When on, I plan a sequence of edits via the agent and run them step by step."
        >
          Auto-edit {autoEdit ? "on" : "off"}
        </button>
      </div>

      {/* Transcript */}
      <div ref={scrollRef} className="min-h-0 flex-1 space-y-2.5 overflow-y-auto py-3">
        {messages.map((m) => (
          <MessageBubble key={m.id} message={m} />
        ))}

        {/* Live job progress (shared style with the other AI sections). */}
        {job.active && (
          <div className="flex flex-col gap-1 rounded-lg bg-panelraised px-3 py-2">
            <div className="h-1.5 w-full overflow-hidden rounded bg-edge">
              <div
                className="h-full bg-accent transition-all"
                style={{ width: `${Math.max(5, job.progress * 100)}%` }}
              />
            </div>
            <span className="text-[11px] text-muted">{prettyStage(job.stage)}</span>
          </div>
        )}
      </div>

      {/* Composer */}
      <div className="border-t border-edge pt-2">
        <div className="flex items-end gap-2">
          <textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={onKeyDown}
            rows={2}
            disabled={busy}
            placeholder={
              autoEdit
                ? "e.g. make it look like a vintage film photo"
                : "e.g. make the sky a warm sunset — or: add a red bird"
            }
            className="min-h-0 flex-1 resize-none rounded-md border border-edge bg-panelraised px-2.5 py-2 text-sm outline-none placeholder:text-muted/60 focus:border-accent disabled:opacity-60"
          />
          <button
            type="button"
            className="btn btn-accent flex-none justify-center px-3 py-2"
            onClick={() => void onSend()}
            disabled={busy || !input.trim()}
          >
            {busy ? "…" : "Send"}
          </button>
        </div>
        <p className="mt-1 px-0.5 text-[10px] text-muted/60">
          Enter to send · Shift+Enter for a new line
        </p>
      </div>
    </div>
  );
}

// ──────────────────────────────────────────────────────────────
// Presentation
// ──────────────────────────────────────────────────────────────

function MessageBubble({ message }: { message: ChatMessage }) {
  const isUser = message.role === "user";
  const toneClass =
    message.tone === "error"
      ? "text-rose-300"
      : message.tone === "muted"
        ? "text-muted"
        : "text-ink";
  return (
    <div className={`flex ${isUser ? "justify-end" : "justify-start"}`}>
      <div
        className={`max-w-[92%] rounded-2xl px-3 py-2 text-sm leading-relaxed ${
          isUser
            ? "rounded-br-sm bg-accent text-white"
            : `rounded-bl-sm bg-panelraised ${toneClass}`
        }`}
      >
        <p className="whitespace-pre-wrap">{message.text}</p>
        {message.plan && <PlanList plan={message.plan} />}
      </div>
    </div>
  );
}

function PlanList({ plan }: { plan: PlanView }) {
  return (
    <ol className="mt-2 flex flex-col gap-1.5">
      {plan.steps.map((step, i) => {
        const status = plan.status[i] ?? "pending";
        return (
          <li
            key={i}
            className="flex items-start gap-2 rounded-md border border-edge bg-panel px-2 py-1.5"
          >
            <StepIcon status={status} />
            <div className="min-w-0 flex-1">
              <p className="truncate text-[12px] text-ink">{stepTitle(step)}</p>
              {step.rationale && (
                <p className="truncate text-[10px] text-muted/70">{step.rationale}</p>
              )}
            </div>
          </li>
        );
      })}
    </ol>
  );
}

function StepIcon({ status }: { status: PlanView["status"][number] }) {
  const base =
    "mt-0.5 flex h-3.5 w-3.5 flex-none items-center justify-center rounded-full text-[9px] font-bold";
  switch (status) {
    case "done":
      return <span className={`${base} bg-emerald-500/20 text-emerald-400`}>✓</span>;
    case "running":
      return (
        <span className={`${base} bg-accent/20 text-accent`}>
          <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-accent" />
        </span>
      );
    case "error":
      return <span className={`${base} bg-rose-500/20 text-rose-400`}>!</span>;
    default:
      return <span className={`${base} bg-edge text-muted`}>•</span>;
  }
}
