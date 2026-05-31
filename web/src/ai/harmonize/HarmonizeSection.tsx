/**
 * HARMONIZE — relight + color-grade an inserted subject so it sits convincingly
 * in the scene below it (and add a contact shadow).
 *
 * The ACTIVE raster layer is treated as the inserted subject (foreground). The
 * layers BELOW it are the scene (background). We:
 *   1. export the active layer's RGBA region (its alpha = the subject
 *      silhouette) as the FOREGROUND,
 *   2. export the whole-document composite and crop it to the SAME region as the
 *      BACKGROUND,
 *   3. presign-upload both, then post a `harmonize` job with that region as the
 *      `roi`, and
 *   4. on success drop the harmonized RGBA subject back at the source ROI as a
 *      NEW layer above the original (non-destructive — the source stays beneath).
 *
 * NOTE on the background: the engine has no "composite of just the layers below"
 * export, so we approximate it with the WHOLE-document composite (which includes
 * the subject itself). The backend composites the supplied foreground over this
 * background and re-keys through the foreground's alpha, so the only artifact of
 * the approximation is that the subject's own pixels appear faintly in the
 * scene the model relights against — acceptable for grading/relight, and the
 * final result is re-keyed to the original subject silhouette regardless.
 * FOLLOWUP: add an `exportLayersBelowPNG` engine method for an exact backdrop.
 */
import { useState } from "react";
import type {
  CreateJobRequest,
  HarmonizeInputs,
  Rect,
} from "@aips/shared-types";
import { idempotencyKey, presignUpload } from "../apiClient";
import {
  engine,
  actions,
  useEngineSnapshot,
} from "../../state/useEngine";
import { useAiJob } from "../useAiJob";
import { Field, JobStatus } from "../AiSectionShell";

/**
 * Crop a PNG Blob to `roi` (pixel rect in the image's own space) and re-encode
 * it as a PNG, preserving alpha. Used to slice the whole-document composite down
 * to the subject's footprint so it matches the foreground's dimensions.
 */
async function cropPngBlob(blob: Blob, roi: Rect): Promise<Blob> {
  const bitmap = await createImageBitmap(blob, {
    premultiplyAlpha: "none",
    colorSpaceConversion: "none",
  });
  const w = Math.max(1, Math.round(roi.width));
  const h = Math.max(1, Math.round(roi.height));
  const canvas =
    typeof OffscreenCanvas !== "undefined"
      ? new OffscreenCanvas(w, h)
      : Object.assign(document.createElement("canvas"), {
          width: w,
          height: h,
        });
  const ctx = (canvas as HTMLCanvasElement | OffscreenCanvas).getContext("2d", {
    colorSpace: "srgb",
  }) as CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;
  ctx.clearRect(0, 0, w, h);
  // Draw the source region at the origin (sx,sy = roi origin in source space).
  ctx.drawImage(bitmap, roi.x, roi.y, w, h, 0, 0, w, h);
  bitmap.close();
  if (canvas instanceof OffscreenCanvas) {
    return canvas.convertToBlob({ type: "image/png" });
  }
  return new Promise<Blob>((resolve, reject) => {
    (canvas as HTMLCanvasElement).toBlob(
      (b) => (b ? resolve(b) : reject(new Error("toBlob failed"))),
      "image/png",
    );
  });
}

export function HarmonizeSection() {
  const snap = useEngineSnapshot();
  const job = useAiJob();
  const [strength, setStrength] = useState(0.6);

  // Harmonize operates on raster pixels: the active layer must be a raster
  // layer, and there must be at least one layer beneath it to harmonize into.
  const activeId = snap.activeLayerId;
  const isRaster =
    !!activeId &&
    snap.layers.find((l) => l.id === activeId)?.kind === "raster";
  // `layers` is ordered top -> bottom; the active layer must not be the
  // bottom-most for there to be a scene below it.
  const activeIndex = snap.layers.findIndex((l) => l.id === activeId);
  const hasLayerBelow = activeIndex >= 0 && activeIndex < snap.layers.length - 1;
  const canRun = isRaster && hasLayerBelow && !job.busy;

  async function onRun() {
    if (!activeId || !canRun) return;
    // Pin the result to the doc active at job start (the user may switch tabs).
    const targetDocId = engine.getActiveDocumentId();
    const geo = engine.getLayerGeometry(activeId);
    if (!geo) return;
    // The subject's footprint in document space — both buffers are sized to
    // this rect and the result is placed back here.
    const roi: Rect = {
      x: geo.x,
      y: geo.y,
      width: geo.width,
      height: geo.height,
    };

    // Foreground = the active layer's own pixels (RGBA, alpha = silhouette).
    // Background = the whole-doc composite cropped to the SAME roi (approximation
    // of the layers-below scene; see the note at the top of the file).
    const [foregroundBlob, docComposite] = await Promise.all([
      engine.exportLayerRegionPNG(activeId, roi),
      actions.exportImage({ format: "png" }),
    ]);
    const backgroundBlob = await cropPngBlob(docComposite, roi);

    const [foreground, background] = await Promise.all([
      presignUpload(foregroundBlob),
      presignUpload(backgroundBlob),
    ]);

    const inputs: HarmonizeInputs = {
      foreground,
      background,
      roi,
      strength,
    };
    const key = await idempotencyKey({ capability: "harmonize", inputs });
    const req: CreateJobRequest<"harmonize"> = {
      capability: "harmonize",
      inputs,
      qualityTier: "quality",
      idempotencyKey: key,
    };

    await job.run(req, {
      onArtifact: async (blob, art) => {
        const name = art.placement?.suggestedLayerName ?? "Harmonized";
        // Drop the harmonized subject back where it came from (above the source).
        const place = art.placement?.roi ?? roi;
        if (targetDocId) {
          await engine.placeImageOnDocument(targetDocId, blob, name, place);
        } else {
          const id = await engine.loadImageLayer(blob, name);
          engine.setLayerPosition(id, place.x, place.y);
        }
      },
    });
  }

  return (
    <div className="flex flex-col gap-3">
      <p className="text-xs leading-relaxed text-muted">
        Make the active layer look like it belongs in the scene below it —
        matched lighting, color grade and a contact shadow. Added as a new layer
        above the original.
      </p>

      <Field
        label={`Strength · ${Math.round(strength * 100)}%`}
        hint="Higher = more aggressive relight / grade toward the scene."
      >
        <input
          type="range"
          min={0}
          max={1}
          step={0.05}
          value={strength}
          onChange={(e) => setStrength(Number(e.target.value))}
          disabled={job.busy}
          className="accent-accent"
        />
      </Field>

      {!activeId && (
        <p className="text-xs text-amber-400">Add or select a layer first.</p>
      )}
      {activeId && !isRaster && (
        <p className="text-xs text-amber-400">
          Select a raster (pixel) layer — the inserted subject.
        </p>
      )}
      {activeId && isRaster && !hasLayerBelow && (
        <p className="text-xs text-amber-400">
          Put the subject on a layer above the scene it should blend into.
        </p>
      )}

      <button
        className="btn btn-accent justify-center py-2"
        onClick={onRun}
        disabled={!canRun}
      >
        {job.busy ? "Harmonizing…" : "Harmonize"}
      </button>

      <JobStatus {...job} doneLabel="Harmonized layer added." />
    </div>
  );
}
