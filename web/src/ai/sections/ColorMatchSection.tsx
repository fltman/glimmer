/**
 * COLOR MATCH — transfer the color grade (palette / tone) of a reference image
 * onto the active image. Pure local op server-side (Reinhard mean/std transfer
 * in CIE Lab — no model call), so it's fast and cheap.
 *
 * Source: the ACTIVE raster layer's region is preferred (so the regraded layer
 * lands on that footprint); otherwise we fall back to the whole-document
 * composite at (0,0). The reference image is any picture from disk — we
 * presign-upload it to get its AssetRef. On run we upload the source PNG, post a
 * `color_match` job, and on success drop the regraded result as a NEW layer
 * (non-destructive — the source stays beneath; alpha is preserved by the
 * backend).
 *
 * Per the backend contract:
 *   - image:     the image to re-grade (required)
 *   - reference: the grade source (required)
 *   - strength:  0..1 (optional; server default 1 = full transfer)
 * The provider key stays on the server; the browser only ever sees presigned
 * URLs.
 */
import { useRef, useState } from "react";
import type {
  AssetRef,
  ColorMatchInputs,
  CreateJobRequest,
} from "@aips/shared-types";
import { idempotencyKey, presignUpload } from "../apiClient";
import { engine, actions, useEngineSnapshot } from "../../state/useEngine";
import { useAiJob } from "../useAiJob";
import { Field, JobStatus } from "../AiSectionShell";

interface ReferenceState {
  asset: AssetRef;
  /** Object URL for the thumbnail preview (revoked on clear/replace). */
  previewUrl: string;
  fileName: string;
}

export function ColorMatchSection() {
  const snap = useEngineSnapshot();
  const job = useAiJob();
  const [reference, setReference] = useState<ReferenceState | null>(null);
  const [refError, setRefError] = useState<string | null>(null);
  const [uploadingRef, setUploadingRef] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const [strength, setStrength] = useState(1);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const activeId = snap.activeLayerId;
  const activeKind = activeId
    ? snap.layers.find((l) => l.id === activeId)?.kind
    : undefined;
  const hasContent = snap.layers.length > 0;
  const canRun = hasContent && reference !== null && !job.busy && !uploadingRef;

  function clearReference() {
    if (reference) URL.revokeObjectURL(reference.previewUrl);
    setReference(null);
    setRefError(null);
    if (fileInputRef.current) fileInputRef.current.value = "";
  }

  async function acceptReferenceFile(file: File) {
    if (!file.type.startsWith("image/")) {
      setRefError("Please choose an image file.");
      return;
    }
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

  function onPickReference(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (file) void acceptReferenceFile(file);
  }

  function onDrop(e: React.DragEvent) {
    e.preventDefault();
    setDragOver(false);
    if (job.busy || uploadingRef) return;
    const file = e.dataTransfer.files?.[0];
    if (file) void acceptReferenceFile(file);
  }

  async function onRun() {
    if (!canRun || !reference) return;
    // Pin the result to the doc active at job start (the user may switch tabs).
    const targetDocId = engine.getActiveDocumentId();

    // Prefer the active raster layer's region; otherwise re-grade the whole
    // composite at (0,0).
    let imageBlob: Blob;
    let originX = 0;
    let originY = 0;
    let sourcedFromLayer = false;
    if (activeId && activeKind === "raster") {
      const geo = engine.getLayerGeometry(activeId);
      if (geo) {
        imageBlob = await engine.exportLayerRegionPNG(activeId, geo);
        originX = geo.x;
        originY = geo.y;
        sourcedFromLayer = true;
      } else {
        imageBlob = await actions.exportImage({ format: "png" });
      }
    } else {
      imageBlob = await actions.exportImage({ format: "png" });
    }

    const image = await presignUpload(imageBlob);

    // Only send strength when it diverges from the server default (1 = full
    // transfer), so a full match keeps a stable idempotency key.
    const inputs: ColorMatchInputs = {
      image,
      reference: reference.asset,
      ...(Math.abs(strength - 1) > 1e-6 ? { strength } : {}),
    };
    const key = await idempotencyKey({ capability: "color_match", inputs });
    const req: CreateJobRequest<"color_match"> = {
      capability: "color_match",
      inputs,
      qualityTier: "fast",
      idempotencyKey: key,
    };

    await job.run(req, {
      onArtifact: async (blob, art) => {
        const name = art.placement?.suggestedLayerName ?? "Color matched";
        const place = art.placement?.roi
          ? { x: art.placement.roi.x, y: art.placement.roi.y }
          : sourcedFromLayer
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
        Transfer the color grade — palette and tone — of a reference image onto
        the active image. Fast, local, alpha-preserving. Added as a new layer
        above the original.
      </p>

      {/* Reference image picker (drag/drop or click) */}
      <div className="flex flex-col gap-1.5">
        <span className="text-xs text-muted">Reference grade</span>
        <input
          ref={fileInputRef}
          type="file"
          accept="image/*"
          className="hidden"
          onChange={onPickReference}
        />
        {reference ? (
          <div className="flex items-center gap-2.5 rounded-md border border-edge bg-panelraised p-2">
            <img
              src={reference.previewUrl}
              alt="Reference grade"
              className="h-14 w-14 flex-none rounded object-cover ring-1 ring-edge"
            />
            <div className="min-w-0 flex-1">
              <p className="truncate text-xs text-ink">{reference.fileName}</p>
              <p className="text-[10px] text-muted/70">
                Matching colors to this image.
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
            type="button"
            onClick={() => fileInputRef.current?.click()}
            onDragOver={(e) => {
              e.preventDefault();
              setDragOver(true);
            }}
            onDragLeave={() => setDragOver(false)}
            onDrop={onDrop}
            disabled={uploadingRef || job.busy}
            className={`flex flex-col items-center justify-center gap-1 rounded-md border border-dashed px-3 py-5 text-center text-xs transition-colors disabled:cursor-not-allowed disabled:opacity-60 ${
              dragOver
                ? "border-accent bg-accent/10 text-ink"
                : "border-edge bg-panelraised text-muted hover:text-ink"
            }`}
          >
            <span className="text-base leading-none" aria-hidden>
              ⤓
            </span>
            <span>
              {uploadingRef
                ? "Uploading…"
                : "Drop an image, or click to choose"}
            </span>
          </button>
        )}
        {refError && <p className="text-xs text-rose-400">{refError}</p>}
      </div>

      {/* Strength */}
      <Field
        label={`Strength · ${Math.round(strength * 100)}%`}
        hint="0% = original colors. 100% = full transfer toward the reference grade."
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
          aria-label="Strength"
        />
      </Field>

      {!hasContent && (
        <p className="text-xs text-amber-400">Add or generate an image first.</p>
      )}
      {hasContent && !reference && (
        <p className="text-xs text-muted/80">Attach a reference image to match.</p>
      )}
      {hasContent && activeId && activeKind !== "raster" && (
        <p className="text-[11px] text-muted/80">
          Active layer isn’t a pixel layer — color-matching the whole composite.
        </p>
      )}

      <button
        className="btn btn-accent justify-center py-2"
        onClick={onRun}
        disabled={!canRun}
      >
        {job.busy ? "Matching…" : "Color Match"}
      </button>

      <JobStatus {...job} doneLabel="Color-matched layer added." />
    </div>
  );
}
