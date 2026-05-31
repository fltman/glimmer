/**
 * EXPAND — outpaint. Adds generated content around the active layer. The user
 * picks per-side margins (presets 1.5×/2× compute symmetric margins from the
 * layer size, or type exact pixel amounts). The result's placement.roi uses
 * negative x/y so the original content stays put; we honor it via
 * setLayerPosition.
 */
import { useState } from "react";
import type { CreateJobRequest, OutpaintInputs } from "@aips/shared-types";
import { idempotencyKey, presignUpload } from "../apiClient";
import { engine, useEngineSnapshot } from "../../state/useEngine";
import { useAiJob } from "../useAiJob";
import { Field, JobStatus } from "../AiSectionShell";

interface Margins {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

const ZERO: Margins = { top: 0, right: 0, bottom: 0, left: 0 };

export function ExpandSection() {
  const snap = useEngineSnapshot();
  const [margins, setMargins] = useState<Margins>(ZERO);
  const [prompt, setPrompt] = useState("");
  const job = useAiJob();

  const activeId = snap.activeLayerId;
  const total = margins.top + margins.right + margins.bottom + margins.left;
  const canRun = !!activeId && !job.busy && total > 0;

  function applyPreset(factor: number) {
    if (!activeId) return;
    const geo = engine.getLayerGeometry(activeId);
    if (!geo) return;
    // Symmetric margins so the image grows by `factor` in each dimension.
    const addW = Math.round((geo.width * (factor - 1)) / 2);
    const addH = Math.round((geo.height * (factor - 1)) / 2);
    setMargins({ top: addH, bottom: addH, left: addW, right: addW });
  }

  function setSide(side: keyof Margins, value: number) {
    setMargins((m) => ({ ...m, [side]: Math.max(0, Math.round(value || 0)) }));
  }

  async function onRun() {
    if (!activeId || !canRun) return;
    // Pin the result to the doc active at job start (the user may switch tabs).
    const targetDocId = engine.getActiveDocumentId();
    const geo = engine.getLayerGeometry(activeId);
    if (!geo) return;
    const imageBlob = await engine.exportLayerRegionPNG(activeId, geo);
    const image = await presignUpload(imageBlob);

    const inputs: OutpaintInputs = {
      image,
      expand: margins,
      ...(prompt.trim() ? { prompt: prompt.trim() } : {}),
    };
    const key = await idempotencyKey({ capability: "outpaint", inputs });
    const req: CreateJobRequest<"outpaint"> = {
      capability: "outpaint",
      inputs,
      qualityTier: "quality",
      idempotencyKey: key,
    };

    await job.run(req, {
      onArtifact: async (blob, art) => {
        const name = art.placement?.suggestedLayerName ?? "Expanded";
        // placement.roi uses the expanded origin (negative offsets from the
        // source). Fall back to the source minus the requested left/top margin.
        const place =
          art.placement?.roi ?? {
            x: geo.x - margins.left,
            y: geo.y - margins.top,
            width: geo.width + margins.left + margins.right,
            height: geo.height + margins.top + margins.bottom,
          };
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
        Grow the canvas around the active layer and let the model paint the new
        area. Choose a preset or set exact margins.
      </p>

      <div className="grid grid-cols-2 gap-1.5">
        <button className="btn justify-center" onClick={() => applyPreset(1.5)}>
          Expand 1.5×
        </button>
        <button className="btn justify-center" onClick={() => applyPreset(2)}>
          Expand 2×
        </button>
      </div>

      <div className="grid grid-cols-2 gap-2">
        {(["top", "right", "bottom", "left"] as const).map((side) => (
          <Field key={side} label={`${side[0]!.toUpperCase()}${side.slice(1)} px`}>
            <input
              type="number"
              min={0}
              step={16}
              value={margins[side]}
              onChange={(e) => setSide(side, Number(e.target.value))}
              className="rounded-md border border-edge bg-panelraised px-2.5 py-1.5 text-sm tabular-nums outline-none focus:border-accent"
            />
          </Field>
        ))}
      </div>

      <Field label="Prompt (optional)" hint="Guide what fills the new area.">
        <textarea
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          rows={2}
          placeholder="continue the misty forest"
          className="resize-none rounded-md border border-edge bg-panelraised px-2.5 py-2 text-sm outline-none placeholder:text-muted/60 focus:border-accent"
        />
      </Field>

      {!activeId && (
        <p className="text-xs text-amber-400">Add or select a layer first.</p>
      )}

      <button
        className="btn btn-accent justify-center py-2"
        onClick={onRun}
        disabled={!canRun}
      >
        {job.busy ? "Expanding…" : "Expand"}
      </button>

      <JobStatus {...job} doneLabel="Expanded result added as a new layer." />
    </div>
  );
}
