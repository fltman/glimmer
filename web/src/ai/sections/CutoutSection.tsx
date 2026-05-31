/**
 * CUTOUT — remove background. Client-preferred: posts a remove_background job
 * with preferLocation:"client". If the server replies with a client_directive
 * we run RMBG-1.4 locally in a Web Worker (WebGPU → wasm) and add the cutout as
 * a new "Cutout" layer. If the server returns a real job (fallback) the shared
 * hook subscribes the WS and places the returned cutout/mask artifact.
 *
 * NOTE: the directive's weightsUrl points at a not-yet-seeded MinIO object, so
 * we ignore it and let transformers.js fetch weights from its CDN. FOLLOWUP:
 * self-host the ONNX weights and honor weightsUrl.
 */
import { useEffect, useState } from "react";
import type {
  CreateJobRequest,
  RemoveBackgroundInputs,
} from "@aips/shared-types";
import { idempotencyKey, presignUpload } from "../apiClient";
import { engine, useEngineSnapshot } from "../../state/useEngine";
import { useAiJob } from "../useAiJob";
import { JobStatus } from "../AiSectionShell";
import { removeBackgroundClient } from "../clientProviders/rmbgClient";
import {
  isClientRmbgCapableSync,
  probeClientCapabilities,
} from "../clientProviders/clientCapabilities";

export function CutoutSection() {
  const snap = useEngineSnapshot();
  const job = useAiJob();
  const [clientCapable, setClientCapable] = useState(isClientRmbgCapableSync());
  const [usesWebGpu, setUsesWebGpu] = useState<boolean | null>(null);

  useEffect(() => {
    let live = true;
    void probeClientCapabilities().then((p) => {
      if (!live) return;
      setClientCapable(p.webgpu || p.wasmSimd);
      setUsesWebGpu(p.webgpu);
    });
    return () => {
      live = false;
    };
  }, []);

  const activeId = snap.activeLayerId;
  const canRun = !!activeId && !job.busy;

  /** Export the active layer's full-resolution PNG (straight-alpha sRGB). */
  async function exportActiveLayerPNG(id: string): Promise<Blob> {
    const geo = engine.getLayerGeometry(id);
    if (!geo) throw new Error("Active layer not found.");
    return engine.exportLayerRegionPNG(id, geo);
  }

  async function onRun() {
    if (!activeId || !canRun) return;
    const id = activeId;
    // Pin the result to the doc + source geometry active at job start, so a tab
    // switch mid-job lands the cutout on the right doc at the right origin.
    const targetDocId = engine.getActiveDocumentId();
    const sourceGeo = engine.getLayerGeometry(id);

    let imageBlob: Blob;
    try {
      imageBlob = await exportActiveLayerPNG(id);
    } catch (e) {
      job.failExternal(e instanceof Error ? e.message : String(e));
      return;
    }

    const image = await presignUpload(imageBlob);
    const inputs: RemoveBackgroundInputs = { image };
    const key = await idempotencyKey({
      capability: "remove_background",
      inputs,
    });
    const req: CreateJobRequest<"remove_background"> = {
      capability: "remove_background",
      inputs,
      preferLocation: "client",
      idempotencyKey: key,
    };

    await job.run(req, {
      // Server fallback path: place the returned cutout/mask artifact.
      onArtifact: async (blob, art) => {
        const name = art.placement?.suggestedLayerName ?? "Cutout";
        const place = art.placement?.roi ?? sourceGeo ?? undefined;
        if (targetDocId)
          await engine.placeImageOnDocument(targetDocId, blob, name, place ?? undefined);
        else {
          const newId = await engine.loadImageLayer(blob, name);
          if (place) engine.setLayerPosition(newId, place.x, place.y);
        }
      },
      // Client-preferred path: run RMBG locally on the active layer's pixels.
      onClientDirective: async () => {
        job.beginExternal("loading_model");
        try {
          // Re-export from pixels (the upload is for the server path only).
          const localBlob = await exportActiveLayerPNG(id);
          const { cutout } = await removeBackgroundClient(localBlob, (p) => {
            job.setExternalProgress(p.progress ?? 0, p.stage);
          });
          if (targetDocId)
            await engine.placeImageOnDocument(
              targetDocId,
              cutout,
              "Cutout",
              sourceGeo ?? undefined,
            );
          else {
            const newId = await engine.loadImageLayer(cutout, "Cutout");
            if (sourceGeo) engine.setLayerPosition(newId, sourceGeo.x, sourceGeo.y);
          }
          job.finishExternal();
        } catch (e) {
          job.failExternal(e instanceof Error ? e.message : String(e));
        }
      },
    });
  }

  return (
    <div className="flex flex-col gap-3">
      <p className="text-xs leading-relaxed text-muted">
        Remove the background from the active layer. Runs in your browser
        (RMBG-1.4) when possible — nothing leaves the device.
      </p>

      {clientCapable ? (
        <p className="text-[11px] text-muted/80">
          {usesWebGpu === null
            ? "Checking GPU…"
            : usesWebGpu
              ? "Accelerated with WebGPU."
              : "Running on WebAssembly (no WebGPU detected)."}
        </p>
      ) : (
        <p className="text-[11px] text-amber-400">
          Local model unavailable — will fall back to the server.
        </p>
      )}

      {!activeId && (
        <p className="text-xs text-amber-400">Add or select a layer first.</p>
      )}

      <button
        className="btn btn-accent justify-center py-2"
        onClick={onRun}
        disabled={!canRun}
      >
        {job.busy ? "Removing…" : "Remove Background"}
      </button>

      <JobStatus {...job} doneLabel="Cutout added as a new layer." />
    </div>
  );
}
