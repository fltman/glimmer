/**
 * UPSCALE — 2× / 4× super-resolution. Exports the active layer, uploads it, and
 * posts an upscale job. The result is added as a new layer at the source
 * position (non-destructive). If no provider is configured server-side the job
 * fails; we surface that cleanly rather than leaving a spinner.
 */
import { useState } from "react";
import type { CreateJobRequest, UpscaleInputs } from "@aips/shared-types";
import { idempotencyKey, presignUpload } from "../apiClient";
import { engine, useEngineSnapshot } from "../../state/useEngine";
import { useAiJob } from "../useAiJob";
import { Field, JobStatus } from "../AiSectionShell";

export function UpscaleSection() {
  const snap = useEngineSnapshot();
  const job = useAiJob();
  const [pending, setPending] = useState<2 | 4 | null>(null);
  // Slider is 0..100 (%); the contract wants creativity as 0..1.
  const [creativityPct, setCreativityPct] = useState(0);

  const activeId = snap.activeLayerId;
  const geo = activeId ? engine.getLayerGeometry(activeId) : null;

  async function onUpscale(scale: 2 | 4) {
    if (!activeId || job.busy) return;
    // Pin the result to the doc active at job start (the user may switch tabs).
    const targetDocId = engine.getActiveDocumentId();
    const g = engine.getLayerGeometry(activeId);
    if (!g) return;
    setPending(scale);
    const imageBlob = await engine.exportLayerRegionPNG(activeId, g);
    const image = await presignUpload(imageBlob);

    const creativity = creativityPct / 100;
    // Only send `creativity` when the user dialed in some enhancement, so a
    // plain resample keeps the same idempotency key as before.
    const inputs: UpscaleInputs =
      creativity > 0 ? { image, scale, creativity } : { image, scale };
    const key = await idempotencyKey({ capability: "upscale", inputs });
    const req: CreateJobRequest<"upscale"> = {
      capability: "upscale",
      inputs,
      qualityTier: "quality",
      idempotencyKey: key,
    };

    await job.run(req, {
      onArtifact: async (blob, art) => {
        const name = art.placement?.suggestedLayerName ?? `Upscaled ${scale}×`;
        // Keep the upscaled layer anchored at the source origin.
        if (targetDocId) await engine.placeImageOnDocument(targetDocId, blob, name, g);
        else {
          const id = await engine.loadImageLayer(blob, name);
          engine.setLayerPosition(id, g.x, g.y);
        }
      },
    });
  }

  // Map the common "no provider" failure to a clearer message.
  const friendlyError =
    job.phase === "error" && job.error
      ? /provider|FAL_KEY|REPLICATE|not configured|no upscale/i.test(job.error)
        ? "No upscale provider configured on the server."
        : job.error
      : null;

  return (
    <div className="flex flex-col gap-3">
      <p className="text-xs leading-relaxed text-muted">
        Increase the resolution of the active layer. The upscaled result is
        added as a new layer.
      </p>

      {geo && (
        <p className="text-[11px] text-muted/80 tabular-nums">
          {geo.width}×{geo.height} → {geo.width * 2}×{geo.height * 2} (2×) /{" "}
          {geo.width * 4}×{geo.height * 4} (4×)
        </p>
      )}

      <Field
        label="Creativity"
        hint="0% = faithful resample. Higher adds invented detail — sharper textures and synthesized fine detail (color-matched back to avoid drift)."
      >
        <div className="flex items-center gap-2.5">
          <input
            type="range"
            min={0}
            max={100}
            step={5}
            value={creativityPct}
            onChange={(e) => setCreativityPct(Number(e.target.value))}
            disabled={job.busy}
            className="h-1.5 w-full cursor-pointer appearance-none rounded bg-edge accent-accent disabled:cursor-not-allowed disabled:opacity-60"
            aria-label="Creativity"
          />
          <span className="w-9 shrink-0 text-right text-[11px] tabular-nums text-muted">
            {creativityPct}%
          </span>
        </div>
      </Field>

      <div className="grid grid-cols-2 gap-1.5">
        <button
          className="btn btn-accent justify-center py-2"
          onClick={() => onUpscale(2)}
          disabled={!activeId || job.busy}
        >
          {job.busy && pending === 2 ? "Upscaling…" : "Upscale 2×"}
        </button>
        <button
          className="btn btn-accent justify-center py-2"
          onClick={() => onUpscale(4)}
          disabled={!activeId || job.busy}
        >
          {job.busy && pending === 4 ? "Upscaling…" : "Upscale 4×"}
        </button>
      </div>

      {!activeId && (
        <p className="text-xs text-amber-400">Add or select a layer first.</p>
      )}

      <JobStatus
        phase={job.phase}
        progress={job.progress}
        stage={job.stage}
        error={friendlyError}
        doneLabel="Upscaled layer added."
      />
    </div>
  );
}
