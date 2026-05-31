/**
 * Client-side "Select Anything" (SAM) wrapper around sam.worker.
 *
 * Two-phase API matching the model:
 *   samSetImage(image)            → rasterize + run the vision encoder ONCE; the
 *                                   embeddings stay cached in the worker.
 *   samSegment(points, box, ...)  → run the cheap mask decoder for a point/box
 *                                   prompt (coords in IMAGE px) and get back a
 *                                   single best alpha mask (Uint8, image res).
 *
 * The worker is created lazily and reused so the model + the current image's
 * embeddings stay warm across clicks. Runs entirely in the browser (WebGPU →
 * wasm), no provider call.
 */
import { markSamReady } from "./clientCapabilities";
import type { SamRequest, SamResponse, SamPoint, SamBox } from "./samProtocol";

export interface SamProgress {
  stage: "loading_model" | "encoding" | "decoding";
  /** 0..1 where known. */
  progress?: number;
  file?: string;
}

export interface SamMaskResult {
  /** Single-channel alpha mask (0..255), one byte per pixel, at image res. */
  mask: Uint8Array;
  width: number;
  height: number;
  /** Decoder score of the returned best mask (higher = more confident). */
  score: number;
}

let worker: Worker | null = null;
let reqSeq = 0;

function getWorker(): Worker {
  if (worker) return worker;
  // Vite resolves this URL form to a bundled ESM worker chunk.
  worker = new Worker(new URL("./sam.worker.ts", import.meta.url), {
    type: "module",
  });
  return worker;
}

/** Rasterize any supported input to straight-alpha RGBA ImageData. */
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
 * Compute + cache the image embeddings for `image`. Resolves once the encoder
 * is done; subsequent samSegment calls reuse the cached embeddings. Returns the
 * image dimensions the masks will be sized to.
 */
export async function samSetImage(
  image: ImageBitmap | Blob | ImageData,
  onProgress?: (p: SamProgress) => void,
): Promise<{ width: number; height: number }> {
  const source = await toImageData(image);
  const { width, height } = source;
  const w = getWorker();
  const id = ++reqSeq;

  return new Promise<{ width: number; height: number }>((resolve, reject) => {
    const onMessage = (ev: MessageEvent<SamResponse>) => {
      const msg = ev.data;
      if (!msg || msg.id !== id) return;
      if (msg.type === "progress") {
        onProgress?.({ stage: msg.stage, progress: msg.progress, file: msg.file });
      } else if (msg.type === "image_ready") {
        cleanup();
        markSamReady();
        resolve({ width: msg.width, height: msg.height });
      } else if (msg.type === "error") {
        cleanup();
        reject(new Error(msg.message));
      }
    };
    const onError = (ev: ErrorEvent) => {
      cleanup();
      reject(new Error(ev.message || "SAM worker crashed"));
    };
    const cleanup = () => {
      w.removeEventListener("message", onMessage as EventListener);
      w.removeEventListener("error", onError as EventListener);
    };
    w.addEventListener("message", onMessage as EventListener);
    w.addEventListener("error", onError as EventListener);

    const pixelsCopy = source.data.slice();
    const req: SamRequest = {
      type: "set_image",
      id,
      width,
      height,
      pixels: pixelsCopy.buffer as ArrayBuffer,
    };
    w.postMessage(req, [pixelsCopy.buffer as ArrayBuffer]);
  });
}

/**
 * Segment the current image given a point/box prompt (coords in IMAGE px).
 * Returns the single best mask. Requires a prior samSetImage; rejects otherwise.
 */
export async function samSegment(
  points: SamPoint[],
  box: SamBox | null = null,
  onProgress?: (p: SamProgress) => void,
): Promise<SamMaskResult> {
  const w = getWorker();
  const id = ++reqSeq;

  return new Promise<SamMaskResult>((resolve, reject) => {
    const onMessage = (ev: MessageEvent<SamResponse>) => {
      const msg = ev.data;
      if (!msg || msg.id !== id) return;
      if (msg.type === "progress") {
        onProgress?.({ stage: msg.stage, progress: msg.progress, file: msg.file });
      } else if (msg.type === "mask") {
        cleanup();
        resolve({
          mask: new Uint8Array(msg.mask),
          width: msg.width,
          height: msg.height,
          score: msg.score,
        });
      } else if (msg.type === "error") {
        cleanup();
        reject(new Error(msg.message));
      }
    };
    const onError = (ev: ErrorEvent) => {
      cleanup();
      reject(new Error(ev.message || "SAM worker crashed"));
    };
    const cleanup = () => {
      w.removeEventListener("message", onMessage as EventListener);
      w.removeEventListener("error", onError as EventListener);
    };
    w.addEventListener("message", onMessage as EventListener);
    w.addEventListener("error", onError as EventListener);

    const req: SamRequest = { type: "segment", id, points, box };
    w.postMessage(req);
  });
}

/** Tear down the worker (frees GPU memory + the cached image embeddings). */
export function disposeSamWorker(): void {
  worker?.terminate();
  worker = null;
}

export type { SamPoint, SamBox };
