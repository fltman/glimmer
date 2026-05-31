/**
 * Shared presentational bits for the AI action sections: the progress bar +
 * status line, success/error messages, and a labelled field wrapper. Keeps the
 * five sections visually consistent without each re-implementing the chrome.
 */
import type { ReactNode } from "react";
import type { AiJobPhase } from "./useAiJob";

export function Field({
  label,
  children,
  hint,
}: {
  label: string;
  children: ReactNode;
  hint?: string;
}) {
  return (
    <label className="flex flex-col gap-1.5">
      <span className="text-xs text-muted">{label}</span>
      {children}
      {hint && <span className="text-[10px] text-muted/70">{hint}</span>}
    </label>
  );
}

/** Humanize a job stage / external stage string for the status line. */
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
      return "Loading model (first run downloads weights)…";
    case "running":
      return "Processing locally…";
    case "done":
      return "Done";
    default:
      return stage || "Working…";
  }
}

export function JobStatus({
  phase,
  progress,
  stage,
  error,
  doneLabel = "Added as a new layer.",
}: {
  phase: AiJobPhase;
  progress: number;
  stage: string;
  error: string | null;
  doneLabel?: string;
}) {
  const busy = phase === "submitting" || phase === "running";
  return (
    <>
      {busy && (
        <div className="flex flex-col gap-1">
          <div className="h-1.5 w-full overflow-hidden rounded bg-edge">
            <div
              className="h-full bg-accent transition-all"
              style={{ width: `${Math.max(5, progress * 100)}%` }}
            />
          </div>
          <span className="text-[11px] text-muted">{prettyStage(stage)}</span>
        </div>
      )}
      {phase === "done" && (
        <p className="text-xs text-emerald-400">{doneLabel}</p>
      )}
      {phase === "error" && error && (
        <p className="text-xs text-rose-400">{error}</p>
      )}
    </>
  );
}
