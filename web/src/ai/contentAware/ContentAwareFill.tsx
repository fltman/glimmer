/**
 * Content-Aware Fill — one-click object removal that realistically reconstructs
 * the background behind the current selection.
 *
 * Mechanically this is `inpaint` in `mode:"remove"` driven entirely by the live
 * selection (no prompt UI): it exports the selection's tight ROI from the active
 * raster layer (the source pixels) plus the selection mask (white = remove),
 * uploads both, and posts an inpaint job with a fixed "reconstruct the
 * background" prompt. On success the result is dropped as a NEW layer at the
 * artifact's placement ROI, leaving the source layer untouched beneath — fully
 * non-destructive, just like EditSection's Remove.
 *
 * Exposed two ways:
 *   - <ContentAwareFillItem/> — the menu row for the Toolbar's Edit menu. It is
 *     self-gating (disabled unless there's a non-empty selection AND an active
 *     raster layer) and opens the modal on click.
 *   - <ContentAwareFillModal/> — a small floating dialog that owns the job
 *     lifecycle and shows progress (reusing AiSectionShell's JobStatus chrome).
 *
 * React never touches pixels: every pixel read goes through the engine's
 * export* helpers and the result re-enters via engine.loadImageLayer.
 */
import { useState } from "react";
import type { CreateJobRequest, InpaintInputs } from "@aips/shared-types";
import { idempotencyKey, presignUpload } from "../apiClient";
import {
  engine,
  useEngineSnapshot,
  useHasSelection,
} from "../../state/useEngine";
import { useAiJob } from "../useAiJob";
import { JobStatus } from "../AiSectionShell";

/** Fixed prompt — content-aware fill has no prompt UI by design. */
const REMOVE_PROMPT =
  "remove the selected content and realistically reconstruct the background";

/**
 * Returns the active raster layer id iff there is also a non-empty selection,
 * else null. Shared gate for the menu item and the modal's run button.
 */
function useFillTarget(): string | null {
  // Re-render on doc/selection changes so the gate stays live.
  useEngineSnapshot();
  useHasSelection();
  const rasterId = engine.getActiveRasterLayerId();
  if (!rasterId || !engine.hasSelection()) return null;
  return rasterId;
}

/**
 * The Edit-menu row. Calls `onPick` to open the modal; disabled (greyed, with an
 * explanatory tooltip) until the preconditions are met.
 */
export function ContentAwareFillItem({ onPick }: { onPick: () => void }) {
  const target = useFillTarget();
  const disabled = target === null;
  return (
    <button
      className="block w-full px-3 py-1.5 text-left text-xs text-ink transition-colors hover:bg-accent/20 disabled:cursor-not-allowed disabled:text-muted/50 disabled:hover:bg-transparent"
      disabled={disabled}
      title={
        disabled
          ? "Make a selection on a raster layer first"
          : "Remove the selected content and reconstruct the background"
      }
      onClick={() => {
        if (!disabled) onPick();
      }}
    >
      Content-Aware Fill…
    </button>
  );
}

/**
 * The modal. Owns the job lifecycle. Rendered only while open (parent gates on
 * its own state). `onClose` is called on cancel / after a successful fill or to
 * dismiss an error.
 */
export function ContentAwareFillModal({ onClose }: { onClose: () => void }) {
  const target = useFillTarget();
  const job = useAiJob();
  const [ran, setRan] = useState(false);

  const canRun = target !== null && !job.busy;

  async function onRun() {
    const layerId = engine.getActiveRasterLayerId();
    if (!layerId || !engine.hasSelection()) return;
    const roi = engine.getSelectionMaskBounds();
    if (!roi) return;
    setRan(true);

    // Export source pixels + selection mask for the ROI, then upload both.
    let image, mask;
    try {
      const [imageBlob, maskBlob] = await Promise.all([
        engine.exportLayerRegionPNG(layerId, roi),
        engine.exportSelectionMaskPNG(roi),
      ]);
      [image, mask] = await Promise.all([
        presignUpload(imageBlob),
        presignUpload(maskBlob),
      ]);
    } catch (e) {
      job.failExternal(e instanceof Error ? e.message : String(e));
      return;
    }

    const inputs: InpaintInputs = {
      image,
      mask,
      prompt: REMOVE_PROMPT,
      mode: "remove",
      roi,
    };
    const key = await idempotencyKey({ capability: "inpaint", inputs });
    const req: CreateJobRequest<"inpaint"> = {
      capability: "inpaint",
      inputs,
      qualityTier: "quality",
      idempotencyKey: key,
    };

    await job.run(req, {
      onArtifact: async (blob, art) => {
        const name = art.placement?.suggestedLayerName ?? "Content-Aware Fill";
        const newId = await engine.loadImageLayer(blob, name);
        // Place the result back at the source ROI (loadImageLayer adds at 0,0).
        const place = art.placement?.roi ?? roi;
        engine.setLayerPosition(newId, place.x, place.y);
      },
    });
  }

  const noTarget = target === null && !ran;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
      onMouseDown={(e) => {
        // Click on the backdrop closes (but never while a job is in flight).
        if (e.target === e.currentTarget && !job.busy) onClose();
      }}
    >
      <div className="w-[22rem] rounded-lg border border-edge bg-panel p-4 shadow-2xl">
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-sm font-semibold tracking-tight">
            Content-Aware Fill
          </h2>
          <button
            className="text-muted transition-colors hover:text-ink disabled:opacity-40"
            onClick={onClose}
            disabled={job.busy}
            title="Close"
          >
            <svg
              width="14"
              height="14"
              viewBox="0 0 14 14"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
            >
              <path d="M3 3l8 8M11 3l-8 8" />
            </svg>
          </button>
        </div>

        <p className="mb-3 text-xs leading-relaxed text-muted">
          Removes the selected content and reconstructs the background behind it,
          non-destructively on a new layer above the source.
        </p>

        {noTarget && (
          <p className="mb-3 text-xs text-amber-400">
            Make a selection on a raster layer first.
          </p>
        )}

        <button
          className="btn btn-accent w-full justify-center py-2"
          onClick={onRun}
          disabled={!canRun}
        >
          {job.busy ? "Filling…" : "Fill Selection"}
        </button>

        <div className="mt-3">
          <JobStatus {...job} doneLabel="Filled — added as a new layer." />
        </div>

        {job.phase === "done" && (
          <button
            className="btn mt-3 w-full justify-center"
            onClick={onClose}
          >
            Done
          </button>
        )}
      </div>
    </div>
  );
}
