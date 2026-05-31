/**
 * Message protocol between the main thread (depthClient) and depth.worker.
 *
 * Standalone (no transformers.js import) so the client stays lightweight. The
 * worker runs monocular depth estimation (Depth-Anything-V2-Small) and returns
 * a single-channel depth map (0..255).
 *
 * DEPTH CONVENTION: NEAR = BRIGHT (255), FAR = DARK (0). Depth-Anything outputs
 * an *inverse-depth*-like map (closer = larger), which we normalize to 0..255 so
 * the brightest pixels are the nearest. The lens-blur shader treats `focus`
 * 0..1 directly as this normalized near=1 scale.
 */

/** Main thread → worker. */
export type DepthRequest = {
  type: "estimate";
  /** Monotonic id so concurrent requests can be matched to their replies. */
  id: number;
  width: number;
  height: number;
  /** Uint8ClampedArray RGBA bytes, transferable. */
  pixels: ArrayBuffer;
};

/** Worker → main thread. */
export type DepthResponse =
  | {
      type: "progress";
      id: number;
      stage: "loading_model" | "running";
      /** 0..1 where known, else omitted. */
      progress?: number;
      file?: string;
    }
  | {
      type: "result";
      id: number;
      /**
       * Single-channel depth map, one byte per pixel (0..255), at the INPUT
       * resolution. NEAR = 255 (bright), FAR = 0 (dark).
       */
      depth: ArrayBuffer;
      width: number;
      height: number;
    }
  | {
      type: "error";
      id: number;
      message: string;
    };
