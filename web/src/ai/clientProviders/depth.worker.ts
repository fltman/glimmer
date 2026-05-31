/// <reference lib="webworker" />
/**
 * Monocular depth-estimation Web Worker (Depth-Anything-V2-Small).
 *
 * Lazy-loads onnx-community/depth-anything-v2-small via the Transformers.js v3
 * `depth-estimation` pipeline and caches it for the worker's lifetime. Prefers
 * WebGPU, falling back to wasm. Mirrors the rmbg.worker structure (lazy load,
 * progress postMessage, transferable buffers).
 *
 * Output normalization: the pipeline returns a `depth` RawImage whose values are
 * inverse-depth-like (closer = larger). We min/max normalize to 0..255 so the
 * brightest pixels are the NEAREST (near = 255, far = 0) and resize back to the
 * input resolution.
 */
import { pipeline, RawImage, env } from "@huggingface/transformers";
import type { DepthRequest, DepthResponse } from "./depthProtocol";

env.allowRemoteModels = true;
env.allowLocalModels = false;

const MODEL_ID = "onnx-community/depth-anything-v2-small";

/**
 * Minimal depth-estimation pipeline shape. We type it locally and cast the
 * `pipeline(...)` result to it: annotating with the SDK's full pipeline union
 * (`AllTasks[T]`) makes TS report "union type too complex to represent".
 */
type DepthPipeline = (image: RawImage) => Promise<{
  predicted_depth?: { data: Float32Array; dims: number[] };
  depth: RawImage;
}>;

/** Loosely-typed `pipeline` to dodge the heavy generic union resolution. */
const loadDepthPipeline = pipeline as unknown as (
  task: "depth-estimation",
  model: string,
  opts: {
    device: "webgpu" | "wasm";
    progress_callback: (data: {
      status?: string;
      file?: string;
      progress?: number;
    }) => void;
  },
) => Promise<DepthPipeline>;

let pipePromise: Promise<DepthPipeline> | null = null;
let resolvedDevice: "webgpu" | "wasm" = "wasm";

const ctx = self as unknown as DedicatedWorkerGlobalScope;

function post(msg: DepthResponse, transfer?: Transferable[]): void {
  if (transfer && transfer.length) ctx.postMessage(msg, transfer);
  else ctx.postMessage(msg);
}

async function hasWebGpu(): Promise<boolean> {
  const gpu = (self.navigator as Navigator & { gpu?: unknown }).gpu;
  if (!gpu) return false;
  try {
    const adapter = await (
      gpu as { requestAdapter(): Promise<unknown | null> }
    ).requestAdapter();
    return !!adapter;
  } catch {
    return false;
  }
}

function loadPipeline(id: number): Promise<DepthPipeline> {
  if (pipePromise) return pipePromise;
  pipePromise = (async () => {
    resolvedDevice = (await hasWebGpu()) ? "webgpu" : "wasm";
    const progressCallback = (data: {
      status?: string;
      file?: string;
      progress?: number;
    }) => {
      post({
        type: "progress",
        id,
        stage: "loading_model",
        progress:
          typeof data.progress === "number" ? data.progress / 100 : undefined,
        file: data.file,
      });
    };
    return loadDepthPipeline("depth-estimation", MODEL_ID, {
      device: resolvedDevice,
      progress_callback: progressCallback,
    });
  })();
  return pipePromise;
}

async function run(req: DepthRequest): Promise<void> {
  const { id, width, height, pixels } = req;
  try {
    const pipe = await loadPipeline(id);
    post({ type: "progress", id, stage: "running", progress: 0 });

    const rgba = new Uint8ClampedArray(pixels);
    const image = new RawImage(
      new Uint8ClampedArray(rgba.buffer.slice(0)),
      width,
      height,
      4,
    );

    // The depth-estimation pipeline returns { predicted_depth: Tensor, depth:
    // RawImage }. `depth` is already a single-channel 8-bit visualization
    // (min/max normalized by the pipeline), but its polarity depends on the
    // model; we re-normalize from predicted_depth to guarantee near = bright.
    const result = (await pipe(image)) as {
      predicted_depth?: { data: Float32Array; dims: number[] };
      depth: RawImage;
    };

    let mapW: number;
    let mapH: number;
    let near255: Uint8Array;

    if (result.predicted_depth && result.predicted_depth.dims.length >= 2) {
      const dims = result.predicted_depth.dims;
      mapH = dims[dims.length - 2]!;
      mapW = dims[dims.length - 1]!;
      const d = result.predicted_depth.data;
      let min = Infinity;
      let max = -Infinity;
      for (let i = 0; i < d.length; i++) {
        const v = d[i]!;
        if (v < min) min = v;
        if (v > max) max = v;
      }
      const span = max - min || 1;
      near255 = new Uint8Array(mapW * mapH);
      // Depth-Anything's predicted_depth is larger for NEARER pixels, so the
      // normalized value already maps near→1. Encode near = 255.
      for (let i = 0; i < near255.length; i++) {
        near255[i] = Math.round(((d[i]! - min) / span) * 255);
      }
    } else {
      // Fallback: use the pipeline's visualization RawImage (single channel).
      const dimg = result.depth;
      mapW = dimg.width;
      mapH = dimg.height;
      const src = dimg.data as Uint8Array | Uint8ClampedArray;
      const ch = dimg.channels;
      near255 = new Uint8Array(mapW * mapH);
      for (let i = 0; i < mapW * mapH; i++) near255[i] = src[i * ch] ?? 0;
    }

    // Resize the depth map back to the input resolution via a single-channel
    // RawImage (bilinear), then read its first channel.
    const depthImage = new RawImage(near255, mapW, mapH, 1);
    const resized = await depthImage.resize(width, height);
    const rsrc = resized.data as Uint8Array | Uint8ClampedArray;
    const rch = resized.channels;
    const out = new Uint8Array(width * height);
    if (rch === 1) {
      out.set(rsrc.subarray(0, width * height));
    } else {
      for (let i = 0; i < width * height; i++) out[i] = rsrc[i * rch] ?? 0;
    }

    post({ type: "progress", id, stage: "running", progress: 1 });
    const buf = out.buffer as ArrayBuffer;
    post({ type: "result", id, depth: buf, width, height }, [buf]);
  } catch (err) {
    post({
      type: "error",
      id,
      message: err instanceof Error ? err.message : String(err),
    });
  }
}

ctx.addEventListener("message", (ev: MessageEvent<DepthRequest>) => {
  const msg = ev.data;
  if (msg && msg.type === "estimate") void run(msg);
});

export {};
