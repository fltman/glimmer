/**
 * Client-side monocular depth-estimation wrapper around depth.worker.
 *
 * `estimateDepth(image, onProgress)`:
 *   1. Rasterizes the input (ImageBitmap | Blob | ImageData) to RGBA ImageData.
 *   2. Hands the pixels to the Depth-Anything-V2-Small Web Worker (lazy model
 *      load, WebGPU → wasm) and receives a single-channel depth map.
 *   3. Returns { depth, width, height } where depth is Uint8 (0..255).
 *
 * DEPTH CONVENTION: NEAR = BRIGHT (255), FAR = DARK (0). The lens-blur shader
 * reads `focus` 0..1 directly against this scale (1 = focus on the nearest).
 *
 * The worker is created lazily and reused so the model stays warm.
 */
import { markDepthReady } from "./clientCapabilities";
import type { DepthRequest, DepthResponse } from "./depthProtocol";

export interface DepthProgress {
  stage: "loading_model" | "running";
  /** 0..1 where known. */
  progress?: number;
  file?: string;
}

export interface DepthResult {
  /** Single-channel depth map (0..255), near = 255, far = 0. */
  depth: Uint8Array;
  width: number;
  height: number;
}

let worker: Worker | null = null;
let reqSeq = 0;

function getWorker(): Worker {
  if (worker) return worker;
  worker = new Worker(new URL("./depth.worker.ts", import.meta.url), {
    type: "module",
  });
  return worker;
}

async function toImageData(image: ImageBitmap | Blob | ImageData): Promise<ImageData> {
  if (typeof ImageData !== "undefined" && image instanceof ImageData) return image;
  const bitmap =
    image instanceof Blob
      ? await createImageBitmap(image, {
          premultiplyAlpha: "none",
          colorSpaceConversion: "none",
        })
      : (image as ImageBitmap);
  const { width, height } = bitmap;
  const canvas = new OffscreenCanvas(width, height);
  const ctx = canvas.getContext("2d", { willReadFrequently: true })!;
  ctx.drawImage(bitmap, 0, 0);
  if (image instanceof Blob) bitmap.close();
  return ctx.getImageData(0, 0, width, height);
}

/**
 * Estimate a depth map for `image` (near = bright). Runs entirely in the
 * browser (no provider call). Resolves with a doc/layer-sized Uint8 depth map.
 */
export async function estimateDepth(
  image: ImageBitmap | Blob | ImageData,
  onProgress?: (p: DepthProgress) => void,
): Promise<DepthResult> {
  const source = await toImageData(image);
  const { width, height } = source;
  const w = getWorker();
  const id = ++reqSeq;

  const depth = await new Promise<Uint8Array>((resolve, reject) => {
    const onMessage = (ev: MessageEvent<DepthResponse>) => {
      const msg = ev.data;
      if (!msg || msg.id !== id) return;
      if (msg.type === "progress") {
        onProgress?.({ stage: msg.stage, progress: msg.progress, file: msg.file });
      } else if (msg.type === "result") {
        cleanup();
        resolve(new Uint8Array(msg.depth));
      } else if (msg.type === "error") {
        cleanup();
        reject(new Error(msg.message));
      }
    };
    const onError = (ev: ErrorEvent) => {
      cleanup();
      reject(new Error(ev.message || "Depth worker crashed"));
    };
    const cleanup = () => {
      w.removeEventListener("message", onMessage as EventListener);
      w.removeEventListener("error", onError as EventListener);
    };
    w.addEventListener("message", onMessage as EventListener);
    w.addEventListener("error", onError as EventListener);

    const pixelsCopy = source.data.slice();
    const req: DepthRequest = {
      type: "estimate",
      id,
      width,
      height,
      pixels: pixelsCopy.buffer as ArrayBuffer,
    };
    w.postMessage(req, [pixelsCopy.buffer as ArrayBuffer]);
  });

  markDepthReady();
  return { depth, width, height };
}

/** Tear down the worker (frees GPU memory). */
export function disposeDepthWorker(): void {
  worker?.terminate();
  worker = null;
}
