/**
 * Builds the real `ExecutorHelpers` for the agent executor from the app's
 * singletons: the `engine`, the `actions` bag, the job `apiClient`, and the
 * client-side RMBG provider.
 *
 * This is the ONLY place the agent executor touches the live editor + network.
 * `executor.ts` itself is dependency-injected and React-free; this module is the
 * composition root the chat panel calls.
 *
 * `runJob` is a framework-free reimplementation of the useAiJob lifecycle
 * (createJob → WS progress → fetch artifact → place; poll fallback; client
 * directive → local RMBG). The executor needs to AWAIT job completion between
 * steps, and a Promise-returning runner expresses that more directly than the
 * React hook's imperative phase machine — while keeping the exact same wire
 * behavior (idempotency, WS-primary/poll-safety-net, RMBG client path).
 */
import type {
  Capability,
  CreateJobRequest,
  CreateJobResponse,
  Job,
  JobArtifact,
} from "@aips/shared-types";
import {
  connectJobSocket,
  createJob,
  getJob,
  idempotencyKey,
  presignUpload,
} from "../apiClient";
import { engine, actions } from "../../state/useEngine";
import { exportImage } from "../../engine/export";
import { removeBackgroundClient } from "../clientProviders/rmbgClient";
import type { ExecutorEngine, ExecutorHelpers, RunJob } from "./executor";

/** Progress + log surface the panel can render while a plan runs. */
export interface JobProgressHandlers {
  /** Fired with 0..1 progress + a stage label as a job (or local RMBG) advances. */
  onJobProgress?: (progress: number, stage: string) => void;
}

/** Adapt the singleton engine + actions to the executor's narrow interface. */
function buildExecutorEngine(): ExecutorEngine {
  return {
    addAdjustmentLayer: (type, params) =>
      // actions.addAdjustmentLayer returns the new layer id.
      actions.addAdjustmentLayer(type, params) as string,
    applyFilter: (layerId, type, params) => actions.applyFilter(layerId, type, params),
    updateLayerEffect: (id, type, patch) => actions.updateLayerEffect(id, type, patch),
    fillSelection: (c, layerId) => actions.fillSelection(c, layerId),
    setForeground: (c) => actions.setForeground(c),
    selectAll: () => actions.selectAll(),
    clearSelection: () => actions.clearSelection(),
    invertSelection: () => actions.invertSelection(),

    getActiveLayerId: () => engine.getSnapshot().activeLayerId,
    getActiveRasterLayerId: () => engine.getActiveRasterLayerId(),
    getFilterTargetLayerId: () =>
      engine.getActiveRasterLayerId() ?? engine.getTopRasterLayerId(),
    hasSelection: () => engine.hasSelection(),
    getSelectionMaskBounds: () => engine.getSelectionMaskBounds(),
    getLayerGeometry: (id) => engine.getLayerGeometry(id),

    exportComposite: () => exportImage(engine, { format: "png" }),
    exportLayerRegionPNG: (layerId, roi) => engine.exportLayerRegionPNG(layerId, roi),
    exportSelectionMaskPNG: (roi) => engine.exportSelectionMaskPNG(roi),

    loadImageLayer: (src, name) => engine.loadImageLayer(src, name),
    setLayerPosition: (id, x, y) => engine.setLayerPosition(id, x, y),
  };
}

/**
 * Run a job to terminal completion. Resolves after `onArtifact` is awaited on
 * success; rejects on a failed/canceled job or an unhandled client directive.
 * Mirrors useAiJob's WS-primary + 1.5s poll-fallback strategy.
 */
function makeRunJob(progress: JobProgressHandlers): RunJob {
  const report = (p: number, stage: string) => progress.onJobProgress?.(p, stage);

  return async function runJob<C extends Capability>(
    req: CreateJobRequest<C>,
    opts: {
      onArtifact: (blob: Blob, artifact: JobArtifact) => Promise<void> | void;
      onClientDirective?: () => Promise<void> | void;
    },
  ): Promise<void> {
    report(0, "queued");

    await new Promise<void>((resolve, reject) => {
      let settled = false;
      let dispose: (() => void) | null = null;

      const finish = (err?: Error) => {
        if (settled) return;
        settled = true;
        dispose?.();
        dispose = null;
        if (err) reject(err);
        else resolve();
      };

      const placeAndFinish = async (job: Job) => {
        const art = job.artifacts.find((a) => a.kind === "image") ?? job.artifacts[0];
        if (!art) {
          finish(new Error("Job finished but returned no artifact."));
          return;
        }
        try {
          const res = await fetch(art.url);
          if (!res.ok) throw new Error(`Artifact fetch ${res.status}`);
          const blob = await res.blob();
          await opts.onArtifact(blob, art);
          report(1, "done");
          finish();
        } catch (e) {
          finish(e instanceof Error ? e : new Error(String(e)));
        }
      };

      const handleJob = async (job: Job) => {
        if (settled) return;
        report(job.progress, job.stage);
        if (job.status === "succeeded") {
          await placeAndFinish(job);
        } else if (job.status === "failed" || job.status === "canceled") {
          finish(new Error(job.error?.message ?? `Job ${job.status}.`));
        }
      };

      const pollUntilDone = async (jobId: string) => {
        let consecutiveFailures = 0;
        for (let i = 0; i < 200 && !settled; i++) {
          await new Promise((r) => setTimeout(r, 1500));
          if (settled) return;
          try {
            const job = await getJob(jobId);
            consecutiveFailures = 0;
            if (
              job.status === "succeeded" ||
              job.status === "failed" ||
              job.status === "canceled"
            ) {
              await handleJob(job);
              return;
            }
          } catch {
            consecutiveFailures++;
            if (consecutiveFailures >= 20 && !settled) {
              finish(new Error("Lost connection to the server."));
              return;
            }
          }
        }
      };

      (async () => {
        try {
          const resp: CreateJobResponse = await createJob(req);
          if (resp.kind === "client_directive") {
            if (opts.onClientDirective) {
              try {
                await opts.onClientDirective();
                report(1, "done");
                finish();
              } catch (e) {
                finish(e instanceof Error ? e : new Error(String(e)));
              }
            } else {
              finish(
                new Error(
                  `Server returned a client directive for ${req.capability}, which this op can't run.`,
                ),
              );
            }
            return;
          }
          dispose = connectJobSocket(
            resp.job.id,
            (job) => void handleJob(job),
            (code, message) => {
              // Transport-level socket failures are NOT terminal — the poll
              // fallback is the safety net. Only a server-sent application error
              // settles here.
              if (code === "ws_error") return;
              finish(new Error(message));
            },
          );
          await handleJob(resp.job);
          void pollUntilDone(resp.job.id);
        } catch (e) {
          finish(e instanceof Error ? e : new Error(String(e)));
        }
      })();
    });
  };
}

/**
 * Wrap `runJob` so that remove_background's client_directive runs RMBG-1.4
 * locally on the active raster layer (same path as CutoutSection), placing the
 * cutout as a new layer. For every other capability this is a pass-through.
 */
function withClientRmbg(baseRunJob: RunJob, progress: JobProgressHandlers): RunJob {
  return async function runJob(req, opts) {
    if (req.capability !== "remove_background") {
      return baseRunJob(req, opts);
    }
    // The active raster layer at submit time is the cutout source.
    const id = engine.getActiveRasterLayerId();
    return baseRunJob(req, {
      onArtifact: opts.onArtifact,
      onClientDirective: async () => {
        if (!id) throw new Error("No raster layer active for background removal.");
        const geo = engine.getLayerGeometry(id);
        if (!geo) throw new Error("Active layer has no geometry.");
        progress.onJobProgress?.(0, "loading_model");
        const sourceBlob = await engine.exportLayerRegionPNG(id, geo);
        const { cutout } = await removeBackgroundClient(sourceBlob, (p) => {
          progress.onJobProgress?.(p.progress ?? 0, p.stage);
        });
        const newId = await engine.loadImageLayer(cutout, "Cutout");
        engine.setLayerPosition(newId, geo.x, geo.y);
      },
    });
  };
}

/**
 * Compose the full ExecutorHelpers the chat panel hands to `executePlan`.
 * Pass an `onJobProgress` to drive a progress bar while AI-job ops run.
 */
export function buildExecutorHelpers(
  progress: JobProgressHandlers = {},
): ExecutorHelpers {
  const baseRunJob = makeRunJob(progress);
  return {
    engine: buildExecutorEngine(),
    presignUpload,
    idempotencyKey,
    runJob: withClientRmbg(baseRunJob, progress),
  };
}
