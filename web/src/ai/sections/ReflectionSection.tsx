/**
 * REFLECTION — remove reflections / glare off glass, windows, screens, and
 * eyeglasses (the `remove_reflections` capability). A generative Gemini img2img
 * edit that knocks back hotspots and reveals what's behind the glass.
 *
 * Source: the ACTIVE raster layer's region is preferred (so the cleanup is
 * anchored to that layer's footprint); if the active layer isn't a raster layer
 * we fall back to the whole-document composite. On run we presign-upload the
 * exported PNG, post a `remove_reflections` job, and on success drop the result
 * as a NEW layer (non-destructive — the source stays beneath). When sourced from
 * a raster layer the result is anchored at that layer's origin; the composite
 * fallback lands at the document origin (0,0).
 *
 * LIMIT TO SELECTION: when there's a non-empty selection the user can toggle
 * "limit to current selection" — we then send the selection's doc-space bounds
 * (engine.getSelectionMaskBounds()) as `roi`, so the backend crops with context
 * padding, edits just that region, then color-matches + feather-blends it back
 * (pixels outside the ROI stay byte-stable). The selection's ROI is in the SAME
 * doc/pixel space the worker places the artifact back into, so when sourced from
 * the whole composite we honor the artifact's placement.roi directly. When
 * sourced from a raster layer the exported PNG is layer-local; we don't pass an
 * roi in that case (a layer-local crop would be ambiguous against doc-space
 * selection bounds), and clean up the whole exported region instead.
 *
 * Per the backend contract:
 *   - image:    required (the active layer region or composite)
 *   - roi:      optional doc-space Rect to confine the edit (from the selection)
 *   - strength: 0..1 (optional; server default 0.7)
 *   - seed:     optional (not surfaced here)
 * Only roi/strength that diverge from defaults are sent, keeping a stable
 * idempotency key. The provider key stays on the server; the browser only ever
 * sees presigned URLs.
 */
import { useState } from "react";
import type {
  CreateJobRequest,
  RemoveReflectionsInputs,
} from "@aips/shared-types";
import { idempotencyKey, presignUpload } from "../apiClient";
import {
  engine,
  actions,
  useEngineSnapshot,
  useHasSelection,
} from "../../state/useEngine";
import { useAiJob } from "../useAiJob";
import { Field, JobStatus } from "../AiSectionShell";

/** Server-side default reflection-suppression strength. */
const DEFAULT_STRENGTH = 0.7;

export function ReflectionSection() {
  const snap = useEngineSnapshot();
  const hasSelection = useHasSelection();
  const job = useAiJob();
  const [strength, setStrength] = useState(DEFAULT_STRENGTH);
  const [limitToSelection, setLimitToSelection] = useState(false);

  const activeId = snap.activeLayerId;
  const activeKind = activeId
    ? snap.layers.find((l) => l.id === activeId)?.kind
    : undefined;
  // We can clean a raster layer's region, or fall back to the whole composite.
  // Only block if there's literally nothing on the canvas.
  const hasContent = snap.layers.length > 0;
  const canRun = hasContent && !job.busy;

  // The ROI confine is only meaningful for the whole-composite source (its
  // pixels share the document's coordinate space, which is what the selection
  // bounds are in). A layer-sourced export is layer-local, so we ignore the
  // toggle there. Surface that so the toggle's effect isn't a mystery.
  const sourcedFromLayer = !!activeId && activeKind === "raster";
  const willConfine = limitToSelection && hasSelection && !sourcedFromLayer;

  async function onRun() {
    if (!canRun) return;
    // Pin the result to the doc active at job start (the user may switch tabs).
    const targetDocId = engine.getActiveDocumentId();

    // Prefer the active raster layer's region so the cleanup is anchored to its
    // footprint; otherwise process the whole-document composite at (0,0).
    let imageBlob: Blob;
    let originX = 0;
    let originY = 0;
    let fromLayer = false;
    if (sourcedFromLayer && activeId) {
      const geo = engine.getLayerGeometry(activeId);
      if (geo) {
        imageBlob = await engine.exportLayerRegionPNG(activeId, geo);
        originX = geo.x;
        originY = geo.y;
        fromLayer = true;
      } else {
        imageBlob = await actions.exportImage({ format: "png" });
      }
    } else {
      imageBlob = await actions.exportImage({ format: "png" });
    }

    const image = await presignUpload(imageBlob);

    // Confine to the selection only for the composite source (doc-space ROI).
    const roi =
      limitToSelection && hasSelection && !fromLayer
        ? engine.getSelectionMaskBounds()
        : null;

    // Only send optional fields when they diverge from the server defaults, so
    // a plain "clean the whole image at 70%" keeps a stable idempotency key.
    const inputs: RemoveReflectionsInputs = {
      image,
      ...(roi ? { roi } : {}),
      ...(Math.abs(strength - DEFAULT_STRENGTH) > 1e-6 ? { strength } : {}),
    };
    const key = await idempotencyKey({
      capability: "remove_reflections",
      inputs,
    });
    const req: CreateJobRequest<"remove_reflections"> = {
      capability: "remove_reflections",
      inputs,
      qualityTier: "quality",
      idempotencyKey: key,
    };

    await job.run(req, {
      onArtifact: async (blob, art) => {
        const name = art.placement?.suggestedLayerName ?? "Reflections removed";
        // Honor an artifact placement roi first (the backend reports where the
        // cleaned pixels belong — the confined ROI, or whole-image origin);
        // otherwise anchor a layer-sourced result back at its origin.
        const place = art.placement?.roi
          ? { x: art.placement.roi.x, y: art.placement.roi.y }
          : fromLayer
            ? { x: originX, y: originY }
            : undefined;
        if (targetDocId) {
          await engine.placeImageOnDocument(targetDocId, blob, name, place);
        } else {
          const id = await engine.loadImageLayer(blob, name);
          if (place) engine.setLayerPosition(id, place.x, place.y);
        }
      },
    });
  }

  return (
    <div className="flex flex-col gap-3">
      <p className="text-xs leading-relaxed text-muted">
        Remove reflections and glare off glass, windows, screens, and
        eyeglasses — revealing what’s behind the surface. Added as a new layer
        above the original.
      </p>

      {/* Limit to selection */}
      <Field
        label="Limit to current selection"
        hint={
          !hasSelection
            ? "Make a selection (marquee/lasso) to confine the cleanup to it."
            : sourcedFromLayer
              ? "Ignored while a pixel layer is active — the whole layer region is cleaned."
              : "Cleans only the selected region; the rest stays pixel-for-pixel untouched."
        }
      >
        <button
          type="button"
          role="switch"
          aria-checked={willConfine}
          disabled={job.busy || !hasSelection || sourcedFromLayer}
          onClick={() => setLimitToSelection((v) => !v)}
          className={`flex items-center justify-between rounded-md border px-2.5 py-2 text-[11px] font-semibold uppercase tracking-wide transition-colors disabled:cursor-not-allowed disabled:opacity-60 ${
            willConfine
              ? "border-accent bg-accent text-white"
              : "border-edge bg-panelraised text-muted hover:text-ink"
          }`}
        >
          <span>{willConfine ? "Confined to selection" : "Whole image"}</span>
          <span
            aria-hidden
            className={`ml-2 inline-flex h-4 w-7 flex-none items-center rounded-full px-0.5 transition-colors ${
              willConfine ? "bg-white/30" : "bg-edge"
            }`}
          >
            <span
              className={`h-3 w-3 rounded-full bg-white transition-transform ${
                willConfine ? "translate-x-3" : "translate-x-0"
              }`}
            />
          </span>
        </button>
      </Field>

      {/* Strength */}
      <Field
        label={`Strength · ${Math.round(strength * 100)}%`}
        hint="0% = a light touch that only knocks back the strongest hotspots. 100% = remove reflections completely and fully reveal what’s behind."
      >
        <div className="flex items-center gap-2.5">
          <input
            type="range"
            min={0}
            max={1}
            step={0.05}
            value={strength}
            onChange={(e) => setStrength(Number(e.target.value))}
            disabled={job.busy}
            className="h-1.5 w-full cursor-pointer appearance-none rounded bg-edge accent-accent disabled:cursor-not-allowed disabled:opacity-60"
            aria-label="Strength"
          />
          <span className="w-9 shrink-0 text-right text-[11px] tabular-nums text-muted">
            {Math.round(strength * 100)}%
          </span>
        </div>
      </Field>

      {!hasContent && (
        <p className="text-xs text-amber-400">Add or generate an image first.</p>
      )}
      {hasContent && activeId && activeKind !== "raster" && (
        <p className="text-[11px] text-muted/80">
          Active layer isn’t a pixel layer — cleaning the whole composite.
        </p>
      )}

      <button
        className="btn btn-accent justify-center py-2"
        onClick={onRun}
        disabled={!canRun}
      >
        {job.busy ? "Removing reflections…" : "Remove reflections"}
      </button>

      <JobStatus {...job} doneLabel="Reflections removed — new layer added." />
    </div>
  );
}
