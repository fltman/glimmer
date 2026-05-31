/**
 * EDIT — generative fill / object removal (inpaint). The centerpiece.
 *
 * Requires an active raster layer + a non-empty selection. On run it exports the
 * selection's ROI from the active layer (image) and the selection mask (white =
 * regenerate), uploads both, posts an inpaint job, and on success drops the
 * result as a NEW layer positioned at the artifact's placement ROI (kept
 * non-destructive — the source layer is untouched beneath).
 */
import { useState } from "react";
import type { CreateJobRequest, InpaintInputs } from "@aips/shared-types";
import { idempotencyKey, presignUpload } from "../apiClient";
import { engine, useEngineSnapshot, useHasSelection } from "../../state/useEngine";
import { useAiJob } from "../useAiJob";
import { Field, JobStatus } from "../AiSectionShell";

type Mode = "fill" | "remove";

export function EditSection() {
  const snap = useEngineSnapshot();
  const hasSelection = useHasSelection();
  const [prompt, setPrompt] = useState("");
  const [mode, setMode] = useState<Mode>("fill");
  const job = useAiJob();

  const activeId = snap.activeLayerId;
  const ready = !!activeId && hasSelection;
  const canRun =
    ready && !job.busy && (mode === "remove" || prompt.trim().length > 0);

  async function onRun() {
    if (!activeId || !canRun) return;
    const roi = engine.getSelectionMaskBounds();
    if (!roi) return;

    // Export source pixels + mask for the ROI, then upload both.
    const [imageBlob, maskBlob] = await Promise.all([
      engine.exportLayerRegionPNG(activeId, roi),
      engine.exportSelectionMaskPNG(roi),
    ]);
    const [image, mask] = await Promise.all([
      presignUpload(imageBlob),
      presignUpload(maskBlob),
    ]);

    const inputs: InpaintInputs = {
      image,
      mask,
      // `remove` allows an empty prompt (erase); `fill` is gated on a non-empty
      // prompt by `canRun` above. Either way send the trimmed value.
      prompt: prompt.trim(),
      mode,
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
        const name =
          art.placement?.suggestedLayerName ??
          (mode === "remove" ? "Removed" : "Generative fill");
        const id = await engine.loadImageLayer(blob, name);
        // Place the result back at the source ROI (loadImageLayer adds at 0,0).
        const place = art.placement?.roi ?? roi;
        engine.setLayerPosition(id, place.x, place.y);
      },
    });
  }

  return (
    <div className="flex flex-col gap-3">
      <p className="text-xs leading-relaxed text-muted">
        Select a region, then fill it from a prompt or remove an object —
        non-destructively, on a new layer above the source.
      </p>

      {/* Fill / Remove toggle */}
      <div className="grid grid-cols-2 gap-1.5">
        <button
          className={`btn justify-center ${mode === "fill" ? "btn-accent" : ""}`}
          onClick={() => setMode("fill")}
        >
          Fill
        </button>
        <button
          className={`btn justify-center ${mode === "remove" ? "btn-accent" : ""}`}
          onClick={() => setMode("remove")}
        >
          Remove
        </button>
      </div>

      <Field
        label={mode === "fill" ? "Prompt" : "Prompt (optional)"}
        hint={
          mode === "remove"
            ? "Leave empty to erase the selected object."
            : undefined
        }
      >
        <textarea
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          rows={3}
          placeholder={
            mode === "fill"
              ? "A bunch of red tulips in a glass vase"
              : "(optional) what should replace it"
          }
          className="resize-none rounded-md border border-edge bg-panelraised px-2.5 py-2 text-sm outline-none placeholder:text-muted/60 focus:border-accent"
        />
      </Field>

      {!activeId && (
        <p className="text-xs text-amber-400">Add or select a layer first.</p>
      )}
      {activeId && !hasSelection && (
        <p className="text-xs text-amber-400">
          Make a selection first (marquee or lasso).
        </p>
      )}

      <button
        className="btn btn-accent justify-center py-2"
        onClick={onRun}
        disabled={!canRun}
      >
        {job.busy
          ? "Working…"
          : mode === "fill"
            ? "Generative Fill"
            : "Remove Object"}
      </button>

      <JobStatus {...job} doneLabel="Added as a new layer." />
    </div>
  );
}
