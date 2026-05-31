/**
 * DISTRACTIONS — AI distraction finder + one-click removal.
 *
 * Flow:
 *   1. "Find distractions" exports the flattened composite (actions.exportImage),
 *      presigns it, and POSTs the synchronous /ai/analyze-distractions endpoint
 *      (NOT the job queue). The provider key stays server-side; we only ever see
 *      our own API + presigned URLs.
 *   2. The model returns candidate regions in NORMALIZED [0,1] image coordinates.
 *      We render them as a reviewable LIST (label · severity chip · rationale).
 *   3. "Show" converts the normalized box → doc pixels and SETS a rectangular
 *      doc-space selection so the existing marching-ants marquee makes it visible
 *      and adjustable. We set the selection via engine.setSelectionFromMask with a
 *      doc-sized R8 mask (row 0 = doc-top, matching the selection's storage) — the
 *      same public API "Select Subject" uses.
 *   4. "Remove" sets that selection, then runs an INPAINT job in mode "remove"
 *      over the active raster layer's ROI + the selection mask (the exact export
 *      pattern EditSection/CutoutSection use), and drops the result as a NEW layer
 *      above the source (non-destructive).
 *
 * HONEST UX: the boxes are AI estimates. The user is told to review/fine-tune the
 * marquee (Show) before removing — boxes are approximate by contract.
 *
 * Removal needs a raster layer: we prefer the active layer when it's raster, else
 * fall back to the top raster layer, and message clearly when there is none.
 */
import { useState } from "react";
import type {
  CreateJobRequest,
  DistractionRegion,
  DistractionSeverity,
  InpaintInputs,
} from "@aips/shared-types";
import { idempotencyKey, presignUpload } from "../apiClient";
import { engine, actions, useEngineSnapshot } from "../../state/useEngine";
import { useAiJob } from "../useAiJob";
import { JobStatus } from "../AiSectionShell";
import {
  analyzeDistractions,
  AnalyzeDistractionsError,
} from "./analyzeClient";

/** Per-severity chip styling (dark Tailwind). */
const SEVERITY_CHIP: Record<DistractionSeverity, string> = {
  low: "bg-sky-500/15 text-sky-300 ring-sky-500/30",
  medium: "bg-amber-500/15 text-amber-300 ring-amber-500/30",
  high: "bg-rose-500/15 text-rose-300 ring-rose-500/30",
};

const SEVERITY_RANK: Record<DistractionSeverity, number> = {
  high: 3,
  medium: 2,
  low: 1,
};

/**
 * Convert a normalized [0,1] box to an integer doc-pixel rect, clamped to the
 * document and forced to be at least 1px in each dimension.
 */
function boxToDocRect(
  box: DistractionRegion["box"],
  docW: number,
  docH: number,
): { x: number; y: number; width: number; height: number } {
  let x = Math.round(box.x * docW);
  let y = Math.round(box.y * docH);
  let w = Math.round(box.width * docW);
  let h = Math.round(box.height * docH);
  // Clamp origin inside the doc, then clamp the extent to the remaining space.
  x = Math.min(Math.max(0, x), Math.max(0, docW - 1));
  y = Math.min(Math.max(0, y), Math.max(0, docH - 1));
  w = Math.max(1, Math.min(w, docW - x));
  h = Math.max(1, Math.min(h, docH - y));
  return { x, y, width: w, height: h };
}

/**
 * Set a RECTANGULAR doc-space selection from a doc-pixel rect using the engine's
 * public setSelectionFromMask (doc-sized R8 alpha buffer, row 0 = doc-top). This
 * lights up the existing marching-ants marquee, fully adjustable by the user.
 */
function selectDocRect(rect: {
  x: number;
  y: number;
  width: number;
  height: number;
}): void {
  const snap = engine.getSnapshot();
  const docW = snap.width;
  const docH = snap.height;
  if (docW <= 0 || docH <= 0) return;
  const buf = new Uint8Array(docW * docH); // zeroed = unselected
  const x1 = Math.min(docW, rect.x + rect.width);
  const y1 = Math.min(docH, rect.y + rect.height);
  for (let y = rect.y; y < y1; y++) {
    const row = y * docW;
    for (let x = rect.x; x < x1; x++) buf[row + x] = 255;
  }
  engine.setSelectionFromMask(buf);
}

export function DistractionsSection() {
  const snap = useEngineSnapshot();
  const job = useAiJob();

  const [analyzing, setAnalyzing] = useState(false);
  const [analyzeError, setAnalyzeError] = useState<string | null>(null);
  const [regions, setRegions] = useState<DistractionRegion[] | null>(null);
  const [emptyMessage, setEmptyMessage] = useState<string | null>(null);
  // Which region a "Remove" job is currently running for (drives row spinners).
  const [removingId, setRemovingId] = useState<string | null>(null);
  // True while a "Remove all" batch is walking the high-severity regions.
  const [removingAll, setRemovingAll] = useState(false);

  const docW = snap.width;
  const docH = snap.height;
  const hasDoc = snap.layers.length > 0;

  /** The raster layer removal targets: active-if-raster, else top raster. */
  const targetRasterId =
    engine.getActiveRasterLayerId() ?? engine.getTopRasterLayerId();

  async function onFind() {
    if (analyzing || job.busy) return;
    setAnalyzing(true);
    setAnalyzeError(null);
    setRegions(null);
    setEmptyMessage(null);
    try {
      const blob = await actions.exportImage({ format: "png" });
      const image = await presignUpload(blob);
      const result = await analyzeDistractions(image);
      // Sort high → low so the most worth-removing items surface first.
      const sorted = [...result.distractions].sort(
        (a, b) => SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity],
      );
      setRegions(sorted);
      if (sorted.length === 0) {
        setEmptyMessage(result.message ?? "No obvious distractions found.");
      }
    } catch (e) {
      if (e instanceof AnalyzeDistractionsError) {
        setAnalyzeError(
          e.status >= 500
            ? `The analyzer couldn't run (${e.code}). ${e.message}`
            : e.message,
        );
      } else {
        setAnalyzeError(e instanceof Error ? e.message : String(e));
      }
    } finally {
      setAnalyzing(false);
    }
  }

  /** "Show": set a rectangular selection over the region's box (adjustable). */
  function onShow(region: DistractionRegion) {
    if (docW <= 0 || docH <= 0) return;
    const rect = boxToDocRect(region.box, docW, docH);
    selectDocRect(rect);
  }

  /**
   * "Remove": select the region's box, then run inpaint mode:"remove" over the
   * active raster ROI + the selection mask, dropping the cleaned result as a new
   * layer. Mirrors EditSection's export/mask/placement logic exactly.
   *
   * Returns true only when the result layer was actually placed. `useAiJob.run`
   * resolves (without throwing) on a failed job — and the captured `job.phase`
   * is a stale render snapshot — so the batch caller can't rely on either to
   * detect failure. The `onArtifact` callback fires ONLY on success, so we flip
   * a local flag there and return it.
   */
  async function removeRegion(region: DistractionRegion): Promise<boolean> {
    const rasterId = engine.getActiveRasterLayerId() ?? engine.getTopRasterLayerId();
    if (!rasterId) throw new Error("Removal needs a raster (pixel) layer.");

    // Seed the selection from the box, then read the engine's tight bounds back
    // (so the ROI matches what the marquee actually covers).
    onShow(region);
    const roi = engine.getSelectionMaskBounds();
    if (!roi) throw new Error("Couldn't derive a region to remove.");

    const [imageBlob, maskBlob] = await Promise.all([
      engine.exportLayerRegionPNG(rasterId, roi),
      engine.exportSelectionMaskPNG(roi),
    ]);
    const [image, mask] = await Promise.all([
      presignUpload(imageBlob),
      presignUpload(maskBlob),
    ]);

    const inputs: InpaintInputs = {
      image,
      mask,
      prompt: "", // erase — no fill prompt
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

    let placed = false;
    await job.run(req, {
      onArtifact: async (blob, art) => {
        const name =
          art.placement?.suggestedLayerName ?? `Removed: ${region.label}`;
        const id = await engine.loadImageLayer(blob, name);
        const place = art.placement?.roi ?? roi;
        engine.setLayerPosition(id, place.x, place.y);
        placed = true;
      },
    });
    return placed;
  }

  async function onRemove(region: DistractionRegion) {
    if (job.busy || removingAll || !targetRasterId) return;
    setRemovingId(region.id);
    try {
      await removeRegion(region);
    } catch (e) {
      job.failExternal(e instanceof Error ? e.message : String(e));
    } finally {
      setRemovingId(null);
    }
  }

  /** Optional convenience: remove every high-severity region, one at a time. */
  async function onRemoveAllHigh() {
    if (job.busy || removingAll || !targetRasterId || !regions) return;
    const highs = regions.filter((r) => r.severity === "high");
    if (highs.length === 0) return;
    setRemovingAll(true);
    try {
      for (const region of highs) {
        setRemovingId(region.id);
        // removeRegion resolves true only when the result was placed; a failed
        // job resolves false (useAiJob never throws on failure, and job.phase is
        // a stale closure snapshot), so we stop the batch on the first failure.
        const ok = await removeRegion(region);
        if (!ok) break;
      }
    } catch (e) {
      job.failExternal(e instanceof Error ? e.message : String(e));
    } finally {
      setRemovingId(null);
      setRemovingAll(false);
    }
  }

  const highCount = regions?.filter((r) => r.severity === "high").length ?? 0;
  const busy = analyzing || job.busy || removingAll;

  return (
    <div className="flex flex-col gap-3">
      <p className="text-xs leading-relaxed text-muted">
        Let AI scan the whole image for distracting elements a retoucher would
        remove — photobombers, litter, power lines, sensor dust. Each hit is a{" "}
        <span className="text-ink">suggestion you review</span>: Show drops a
        marquee you can fine-tune, Remove erases it on a new layer.
      </p>

      <button
        className="btn btn-accent justify-center py-2"
        onClick={onFind}
        disabled={busy || !hasDoc}
      >
        {analyzing ? "Scanning…" : "Find distractions"}
      </button>

      {!hasDoc && (
        <p className="text-xs text-amber-400">Open or add a layer first.</p>
      )}

      {analyzeError && <p className="text-xs text-rose-400">{analyzeError}</p>}

      {/* Empty result */}
      {regions !== null && regions.length === 0 && (
        <p className="text-xs text-emerald-400">
          {emptyMessage ?? "No obvious distractions found."}
        </p>
      )}

      {/* Region list */}
      {regions !== null && regions.length > 0 && (
        <div className="flex flex-col gap-2">
          <div className="flex items-center justify-between">
            <span className="text-[11px] uppercase tracking-wide text-muted">
              {regions.length} found
            </span>
            {highCount > 0 && (
              <button
                className="btn px-2 py-1 text-[11px]"
                onClick={onRemoveAllHigh}
                disabled={busy || !targetRasterId}
                title="Remove every high-severity region in sequence"
              >
                Remove all high ({highCount})
              </button>
            )}
          </div>

          {!targetRasterId && (
            <p className="text-xs text-amber-400">
              Removal needs a raster layer — select a pixel layer (the active
              layer is an adjustment/text/group). You can still Show a region.
            </p>
          )}

          <ul className="flex flex-col gap-2">
            {regions.map((region) => {
              const rowBusy =
                removingId === region.id && (job.busy || removingAll);
              return (
                <li
                  key={region.id}
                  className="rounded-md border border-edge bg-panelraised p-2.5"
                >
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="truncate text-sm font-medium text-ink">
                          {region.label}
                        </span>
                        <span
                          className={`flex-none rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide ring-1 ${SEVERITY_CHIP[region.severity]}`}
                        >
                          {region.severity}
                        </span>
                      </div>
                      {region.rationale && (
                        <p className="mt-1 text-[11px] leading-relaxed text-muted">
                          {region.rationale}
                        </p>
                      )}
                    </div>
                  </div>

                  <div className="mt-2 grid grid-cols-2 gap-1.5">
                    <button
                      className="btn justify-center py-1.5 text-[12px]"
                      onClick={() => onShow(region)}
                      disabled={busy}
                      title="Drop an adjustable marquee over this region"
                    >
                      Show
                    </button>
                    <button
                      className="btn btn-accent justify-center py-1.5 text-[12px]"
                      onClick={() => void onRemove(region)}
                      disabled={busy || !targetRasterId}
                      title="Erase this region on a new layer (inpaint)"
                    >
                      {rowBusy ? "Removing…" : "Remove"}
                    </button>
                  </div>
                </li>
              );
            })}
          </ul>

          <p className="text-[10px] leading-relaxed text-muted/70">
            Boxes are AI estimates. Hit Show, nudge the marquee to frame the
            object cleanly, then Remove for the best result.
          </p>
        </div>
      )}

      {/* Removal job progress / errors (shared bar). */}
      <JobStatus {...job} doneLabel="Removed — added as a new layer." />
    </div>
  );
}
