/**
 * SMART PRESETS — one-click cinematic "looks".
 *
 * A grid of preset cards. Clicking a card builds an `AgentPlan` from its def
 * (`presetDefs.ts`) and runs it through the SAME canonical agent executor the
 * Assistant uses — `executePlan(plan, buildExecutorHelpers(), onProgress)` from
 * `web/src/ai/agent`. Every step lands as a real engine edit:
 *   - `add_adjustment` → a non-destructive adjustment LAYER (undoable on its own)
 *   - `apply_filter`   → a destructive pixel filter on the active raster layer
 *
 * Presets are LOCAL ops only — no AI job is enqueued, so applying a look is
 * instant and never touches the network or any provider key. (The executor's
 * `onJobProgress` would only fire for AI-job ops, which presets don't use; we
 * drive our own per-step progress from `executePlan`'s `onProgress`.)
 *
 * Visual language matches the other AI sections: dark Tailwind, the `bg-edge`/
 * `bg-accent` progress bar, `text-muted`/`text-ink` type, `panelraised` cards.
 */
import { useMemo, useState } from "react";
import { useEngineSnapshot } from "../../state/useEngine";
import {
  executePlan,
  buildExecutorHelpers,
  type ExecutorHelpers,
  type ProgressEvent as StepProgressEvent,
} from "../agent";
import {
  PRESETS,
  presetToPlan,
  stepNote,
  type PresetDef,
} from "./presetDefs";

/** Per-step status used to render the live checklist while a preset applies. */
type StepStatus = "pending" | "running" | "done" | "error";

interface RunState {
  presetId: string;
  /** One status per step of the running preset, parallel to the plan steps. */
  status: StepStatus[];
  /** Human notes per step (from `stepNote`), parallel to `status`. */
  notes: string[];
  /** Set when the run settles: how many steps applied / total. */
  summary: { ok: boolean; succeeded: number; total: number } | null;
}

export function PresetsSection() {
  const snap = useEngineSnapshot();
  const [run, setRun] = useState<RunState | null>(null);
  const [busy, setBusy] = useState(false);

  // The document needs at least one layer for a look to land on. (Adjustment
  // layers read the composite below them; filters need a raster target.)
  const hasContent = snap.layers.length > 0;

  // One executor-helpers instance. Presets don't enqueue AI jobs, so we don't
  // wire onJobProgress — per-step progress comes from executePlan's onProgress.
  const helpers = useMemo<ExecutorHelpers>(() => buildExecutorHelpers(), []);

  async function applyPreset(preset: PresetDef) {
    if (busy || !hasContent) return;
    setBusy(true);

    const plan = presetToPlan(preset);
    const notes = plan.steps.map(stepNote);
    setRun({
      presetId: preset.id,
      status: plan.steps.map(() => "pending"),
      notes,
      summary: null,
    });

    const setStepStatus = (i: number, s: StepStatus) =>
      setRun((prev) =>
        prev && prev.presetId === preset.id
          ? { ...prev, status: prev.status.map((v, idx) => (idx === i ? s : v)) }
          : prev,
      );

    const onProgress = (e: StepProgressEvent) => {
      if (e.phase === "start") {
        setStepStatus(e.index, "running");
      } else if (e.result) {
        setStepStatus(e.index, e.result.ok ? "done" : "error");
      }
    };

    try {
      const result = await executePlan(plan, helpers, onProgress);
      setRun((prev) =>
        prev && prev.presetId === preset.id
          ? {
              ...prev,
              summary: {
                ok: result.ok,
                succeeded: result.succeeded,
                total: result.results.length,
              },
            }
          : prev,
      );
    } finally {
      setBusy(false);
    }
  }

  const activePreset = run ? PRESETS.find((p) => p.id === run.presetId) : null;

  return (
    <div className="flex flex-col gap-3">
      <p className="text-xs leading-relaxed text-muted">
        One-click cinematic looks. Each preset stacks a few non-destructive
        adjustment layers (plus the odd grain/contrast filter) — instant, local,
        and fully undoable. No AI, no upload.
      </p>

      {/* Preset grid */}
      <div className="grid grid-cols-2 gap-2">
        {PRESETS.map((preset) => {
          const isActive = run?.presetId === preset.id;
          const isRunning = busy && isActive;
          return (
            <button
              key={preset.id}
              type="button"
              onClick={() => void applyPreset(preset)}
              disabled={busy || !hasContent}
              title={preset.description}
              className={`group flex flex-col gap-1.5 overflow-hidden rounded-lg border p-2 text-left transition-colors disabled:cursor-not-allowed disabled:opacity-60 ${
                isActive
                  ? "border-accent bg-panelraised"
                  : "border-edge bg-panel hover:border-accent/60 hover:bg-panelraised"
              }`}
            >
              {/* Palette swatch */}
              <span
                className="h-8 w-full rounded-md ring-1 ring-inset ring-white/5"
                style={{
                  background: `linear-gradient(135deg, ${preset.swatch[0]}, ${preset.swatch[1]})`,
                }}
                aria-hidden
              />
              <span className="flex items-center gap-1 text-[11px] font-semibold leading-tight text-ink">
                {preset.name}
                {isRunning && (
                  <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-accent" />
                )}
              </span>
              <span className="line-clamp-2 text-[10px] leading-snug text-muted/80">
                {preset.description}
              </span>
            </button>
          );
        })}
      </div>

      {!hasContent && (
        <p className="text-xs text-amber-400">
          Add or open an image first — presets grade the current layers.
        </p>
      )}

      {/* Live per-step trace for the applying preset */}
      {run && activePreset && (
        <div className="flex flex-col gap-2 rounded-lg border border-edge bg-panelraised px-3 py-2.5">
          <div className="flex items-center justify-between">
            <span className="text-[11px] font-semibold text-ink">
              {activePreset.name}
            </span>
            <span className="text-[10px] tabular-nums text-muted">
              {run.status.filter((s) => s === "done").length}/{run.status.length}
            </span>
          </div>

          {/* Aggregate progress bar (shared visual with the other sections). */}
          <div className="h-1.5 w-full overflow-hidden rounded bg-edge">
            <div
              className="h-full bg-accent transition-all"
              style={{
                width: `${Math.max(
                  5,
                  (run.status.filter((s) => s === "done" || s === "error").length /
                    Math.max(1, run.status.length)) *
                    100,
                )}%`,
              }}
            />
          </div>

          {/* Per-step checklist */}
          <ol className="flex flex-col gap-1">
            {run.notes.map((note, i) => {
              const status = run.status[i] ?? "pending";
              return (
                <li key={i} className="flex items-center gap-2">
                  <StepIcon status={status} />
                  <span
                    className={`text-[11px] ${
                      status === "error"
                        ? "text-rose-400"
                        : status === "done"
                          ? "text-muted"
                          : status === "running"
                            ? "text-ink"
                            : "text-muted/70"
                    }`}
                  >
                    {note}
                  </span>
                </li>
              );
            })}
          </ol>

          {/* Final summary */}
          {run.summary && (
            <p
              className={`text-xs ${
                run.summary.ok ? "text-emerald-400" : "text-amber-400"
              }`}
            >
              {run.summary.ok
                ? `“${activePreset.name}” applied — ${run.summary.succeeded} layer${
                    run.summary.succeeded === 1 ? "" : "s"
                  }/filter${run.summary.succeeded === 1 ? "" : "s"}. Undo to revert.`
                : `Applied ${run.summary.succeeded} of ${run.summary.total} steps — the rest need a raster layer.`}
            </p>
          )}
        </div>
      )}
    </div>
  );
}

/** Small status pip mirroring the Assistant's plan checklist. */
function StepIcon({ status }: { status: StepStatus }) {
  const base =
    "flex h-3.5 w-3.5 flex-none items-center justify-center rounded-full text-[9px] font-bold";
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

export default PresetsSection;
