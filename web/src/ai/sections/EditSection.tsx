/**
 * EDIT — generative fill / object removal (inpaint). The centerpiece.
 *
 * Requires an active raster layer + a non-empty selection. On run it exports the
 * selection's ROI from the active layer (image) and the selection mask (white =
 * regenerate), uploads both, posts an inpaint job, and on success drops the
 * result as a NEW layer positioned at the artifact's placement ROI (kept
 * non-destructive — the source layer is untouched beneath).
 *
 * REFERENCE-IMAGE FILL: in `fill` mode the user can optionally attach a
 * reference image (any picture from disk). When set we presign-upload it and
 * include `referenceImage` in the inpaint inputs — the backend then fills the
 * masked region with the object/appearance shown in the reference (identity
 * preserved, scale/perspective/lighting adapted to the scene). With a reference
 * attached the text prompt becomes optional (the backend accepts an empty
 * prompt as long as a reference is present).
 */
import { useRef, useState } from "react";
import type {
  AssetRef,
  CreateJobRequest,
  InpaintInputs,
} from "@aips/shared-types";
import { idempotencyKey, presignUpload } from "../apiClient";
import { engine, useEngineSnapshot, useHasSelection } from "../../state/useEngine";
import { useAiJob } from "../useAiJob";
import { Field, JobStatus } from "../AiSectionShell";

type Mode = "fill" | "remove";

interface ReferenceState {
  asset: AssetRef;
  /** Object URL for the thumbnail preview (revoked on clear/replace). */
  previewUrl: string;
  fileName: string;
}

export function EditSection() {
  const snap = useEngineSnapshot();
  const hasSelection = useHasSelection();
  const [prompt, setPrompt] = useState("");
  const [mode, setMode] = useState<Mode>("fill");
  const [reference, setReference] = useState<ReferenceState | null>(null);
  const [refError, setRefError] = useState<string | null>(null);
  const [uploadingRef, setUploadingRef] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const job = useAiJob();

  const activeId = snap.activeLayerId;
  const ready = !!activeId && hasSelection;
  // With a reference attached, `fill` no longer requires a prompt (the backend
  // accepts prompt OR referenceImage). `remove` never requires a prompt.
  const hasPromptOrRef =
    prompt.trim().length > 0 || (mode === "fill" && reference !== null);
  const canRun =
    ready && !job.busy && !uploadingRef && (mode === "remove" || hasPromptOrRef);

  function clearReference() {
    if (reference) URL.revokeObjectURL(reference.previewUrl);
    setReference(null);
    setRefError(null);
    if (fileInputRef.current) fileInputRef.current.value = "";
  }

  async function onPickReference(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setRefError(null);
    setUploadingRef(true);
    // Revoke any previous preview before swapping it out.
    if (reference) URL.revokeObjectURL(reference.previewUrl);
    setReference(null);
    try {
      const asset = await presignUpload(file);
      setReference({
        asset,
        previewUrl: URL.createObjectURL(file),
        fileName: file.name,
      });
    } catch (err) {
      setRefError(err instanceof Error ? err.message : String(err));
      if (fileInputRef.current) fileInputRef.current.value = "";
    } finally {
      setUploadingRef(false);
    }
  }

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

    // A reference only applies to `fill` (remove erases — no fill source).
    const referenceImage =
      mode === "fill" && reference ? reference.asset : undefined;

    const inputs: InpaintInputs = {
      image,
      mask,
      // `remove` allows an empty prompt (erase); `fill` is gated on a non-empty
      // prompt OR a reference image by `canRun` above. Either way send the
      // trimmed value (the backend accepts "" when a reference is present).
      prompt: prompt.trim(),
      mode,
      roi,
      ...(referenceImage ? { referenceImage } : {}),
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
          (mode === "remove"
            ? "Removed"
            : referenceImage
              ? "Reference fill"
              : "Generative fill");
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
        label={
          mode === "fill"
            ? reference
              ? "Prompt (optional — reference attached)"
              : "Prompt"
            : "Prompt (optional)"
        }
        hint={
          mode === "remove"
            ? "Leave empty to erase the selected object."
            : reference
              ? "Add notes to steer the reference, or leave empty."
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

      {/* Reference image (fill only) */}
      {mode === "fill" && (
        <div className="flex flex-col gap-1.5">
          <span className="text-xs text-muted">Reference image (optional)</span>
          <input
            ref={fileInputRef}
            type="file"
            accept="image/*"
            className="hidden"
            onChange={(e) => void onPickReference(e)}
          />
          {reference ? (
            <div className="flex items-center gap-2.5 rounded-md border border-edge bg-panelraised p-2">
              <img
                src={reference.previewUrl}
                alt="Reference"
                className="h-12 w-12 flex-none rounded object-cover ring-1 ring-edge"
              />
              <div className="min-w-0 flex-1">
                <p className="truncate text-xs text-ink">{reference.fileName}</p>
                <p className="text-[10px] text-muted/70">
                  Filling with this image.
                </p>
              </div>
              <button
                className="btn flex-none px-2 py-1 text-[11px]"
                onClick={clearReference}
                disabled={job.busy}
              >
                Clear
              </button>
            </div>
          ) : (
            <button
              className="btn justify-center py-2"
              onClick={() => fileInputRef.current?.click()}
              disabled={uploadingRef || job.busy}
            >
              {uploadingRef ? "Uploading…" : "Attach reference image"}
            </button>
          )}
          {refError && <p className="text-xs text-rose-400">{refError}</p>}
        </div>
      )}

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
            ? reference
              ? "Reference Fill"
              : "Generative Fill"
            : "Remove Object"}
      </button>

      <JobStatus {...job} doneLabel="Added as a new layer." />
    </div>
  );
}
