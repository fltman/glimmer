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
import { JobStatus } from "../AiSectionShell";

export function UpscaleSection() {
  const snap = useEngineSnapshot();
  const job = useAiJob();
  const [pending, setPending] = useState<2 | 4 | null>(null);

  const activeId = snap.activeLayerId;
  const geo = activeId ? engine.getLayerGeometry(activeId) : null;

  async function onUpscale(scale: 2 | 4) {
    if (!activeId || job.busy) return;
    const g = engine.getLayerGeometry(activeId);
    if (!g) return;
    setPending(scale);
    const imageBlob = await engine.exportLayerRegionPNG(activeId, g);
    const image = await presignUpload(imageBlob);

    const inputs: UpscaleInputs = { image, scale };
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
        const id = await engine.loadImageLayer(blob, name);
        // Keep the upscaled layer anchored at the source origin.
        engine.setLayerPosition(id, g.x, g.y);
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
