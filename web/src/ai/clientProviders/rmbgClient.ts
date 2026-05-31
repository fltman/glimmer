/**
 * Client-side background removal wrapper around rmbg.worker.
 *
 * Exposes `removeBackgroundClient(image, onProgress)` which:
 *   1. Rasterizes the input (ImageBitmap | Blob) to RGBA ImageData.
 *   2. Hands the pixels to the RMBG-1.4 Web Worker (lazy model load, WebGPU →
 *      wasm fallback) and receives a single-channel alpha matte.
 *   3. Composites matte → alpha on an OffscreenCanvas (subject kept, background
 *      transparent) and returns the cutout as an RGBA PNG Blob.
 *
 * The worker is created lazily and reused across calls so the model stays warm.
 */
import { markRmbgReady } from "./clientCapabilities";
import type { RmbgRequest, RmbgResponse } from "./rmbgProtocol";

export interface RmbgProgress {
  stage: "loading_model" | "running";
  /** 0..1 where known. */
  progress?: number;
  file?: string;
}

export interface RmbgResult {
  /** RGBA PNG with the matte applied to alpha. */
  cutout: Blob;
}

let worker: Worker | null = null;
let reqSeq = 0;

function getWorker(): Worker {
  if (worker) return worker;
  // Vite resolves this URL form to a bundled worker chunk (ESM worker).
  worker = new Worker(new URL("./rmbg.worker.ts", import.meta.url), {
    type: "module",
  });
  return worker;
}

/** Rasterize any supported input to straight-alpha RGBA ImageData. */
async function toImageData(
  image: ImageBitmap | Blob,
): Promise<ImageData> {
  const bitmap =
    image instanceof Blob
      ? await createImageBitmap(image, {
          premultiplyAlpha: "none",
          colorSpaceConversion: "none",
        })
      : image;
  const { width, height } = bitmap;
  const canvas = new OffscreenCanvas(width, height);
  const ctx = canvas.getContext("2d", { willReadFrequently: true })!;
  ctx.drawImage(bitmap, 0, 0);
  if (image instanceof Blob) bitmap.close();
  return ctx.getImageData(0, 0, width, height);
}

/** Composite (RGB from source) + (alpha from matte) → RGBA PNG Blob. */
async function compositeCutout(
  source: ImageData,
  matte: Uint8Array,
): Promise<Blob> {
  const { width, height } = source;
  const out = new Uint8ClampedArray(width * height * 4);
  const src = source.data;
  for (let i = 0, p = 0; i < width * height; i++, p += 4) {
    out[p] = src[p]!;
    out[p + 1] = src[p + 1]!;
    out[p + 2] = src[p + 2]!;
    // Multiply the source alpha by the matte so already-transparent pixels stay
    // transparent (matte is white = keep subject).
    const srcA = src[p + 3]! / 255;
    out[p + 3] = Math.round((matte[i] ?? 0) * srcA);
  }
  const canvas = new OffscreenCanvas(width, height);
  const ctx = canvas.getContext("2d")!;
  ctx.putImageData(new ImageData(out, width, height), 0, 0);
  return canvas.convertToBlob({ type: "image/png" });
}

/**
 * Remove the background from `image`, returning an RGBA PNG cutout with a
 * transparent background. Runs entirely in the browser (no provider call).
 */
export async function removeBackgroundClient(
  image: ImageBitmap | Blob,
  onProgress?: (p: RmbgProgress) => void,
): Promise<RmbgResult> {
  const source = await toImageData(image);
  const { width, height } = source;
  const w = getWorker();
  const id = ++reqSeq;

  const matte = await new Promise<Uint8Array>((resolve, reject) => {
    const onMessage = (ev: MessageEvent<RmbgResponse>) => {
      const msg = ev.data;
      if (!msg || msg.id !== id) return;
      if (msg.type === "progress") {
        onProgress?.({
          stage: msg.stage,
          progress: msg.progress,
          file: msg.file,
        });
      } else if (msg.type === "result") {
        cleanup();
        resolve(new Uint8Array(msg.matte));
      } else if (msg.type === "error") {
        cleanup();
        reject(new Error(msg.message));
      }
    };
    const onError = (ev: ErrorEvent) => {
      cleanup();
      reject(new Error(ev.message || "RMBG worker crashed"));
    };
    const cleanup = () => {
      w.removeEventListener("message", onMessage as EventListener);
      w.removeEventListener("error", onError as EventListener);
    };
    w.addEventListener("message", onMessage as EventListener);
    w.addEventListener("error", onError as EventListener);

    // Transfer the pixel buffer to avoid a copy. We copy first because the
    // ImageData buffer is reused for compositing afterwards.
    const pixelsCopy = source.data.slice();
    const req: RmbgRequest = {
      type: "run",
      id,
      width,
      height,
      pixels: pixelsCopy.buffer as ArrayBuffer,
    };
    w.postMessage(req, [pixelsCopy.buffer as ArrayBuffer]);
  });

  const cutout = await compositeCutout(source, matte);
  markRmbgReady();
  return { cutout };
}

/** Tear down the worker (e.g. to free GPU memory). Optional. */
export function disposeRmbgWorker(): void {
  worker?.terminate();
  worker = null;
}
