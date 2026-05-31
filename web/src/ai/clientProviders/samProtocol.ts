/**
 * Message protocol between the main thread (samClient) and sam.worker.
 *
 * Standalone (no transformers.js import) so the client stays lightweight. SAM is
 * a two-phase model: a heavy image-encoder runs ONCE per image (setImage), then
 * a cheap mask-decoder runs per click (segment) reusing the cached embeddings.
 * The worker keeps the embeddings warm for its lifetime; the client only ships
 * point/box prompts after the first setImage.
 */

/** A click prompt in IMAGE pixel space. label 1 = positive (include), 0 = negative. */
export interface SamPoint {
  x: number;
  y: number;
  label: 0 | 1;
}

/** An optional box prompt in IMAGE pixel space (x0,y0 = top-left, x1,y1 = bottom-right). */
export interface SamBox {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/** Main thread → worker. */
export type SamRequest =
  | {
      type: "set_image";
      id: number;
      width: number;
      height: number;
      /** Uint8ClampedArray RGBA bytes, transferable. */
      pixels: ArrayBuffer;
    }
  | {
      type: "segment";
      id: number;
      points: SamPoint[];
      box: SamBox | null;
    };

/** Worker → main thread. */
export type SamResponse =
  | {
      type: "progress";
      id: number;
      /** Coarse phase label for status text. */
      stage: "loading_model" | "encoding" | "decoding";
      /** 0..1 where known, else omitted. */
      progress?: number;
      /** File currently downloading (model warm-up). */
      file?: string;
    }
  | {
      /** set_image embeddings computed + cached. */
      type: "image_ready";
      id: number;
      width: number;
      height: number;
    }
  | {
      type: "mask";
      id: number;
      /** Single-channel alpha mask (0..255), one byte per pixel, at image res. */
      mask: ArrayBuffer;
      width: number;
      height: number;
      /** Decoder IoU/stability score of the returned (best) mask, for the UI. */
      score: number;
    }
  | {
      type: "error";
      id: number;
      message: string;
    };
