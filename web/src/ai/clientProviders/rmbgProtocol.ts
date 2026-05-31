/**
 * Message protocol between the main thread (rmbgClient) and rmbg.worker.
 *
 * Kept in a standalone module so both the worker and the client import the same
 * shapes without the client pulling in the heavy transformers.js dependency.
 */

/** Main thread → worker. */
export type RmbgRequest = {
  type: "run";
  /** Monotonic id so concurrent requests can be matched to their replies. */
  id: number;
  /**
   * Input pixels as ImageData (RGBA, row-major). We pass ImageData rather than
   * an ImageBitmap because RawImage.fromCanvas/ctx is the documented path and
   * ImageData transfers cheaply via its backing ArrayBuffer.
   */
  width: number;
  height: number;
  pixels: ArrayBuffer; // Uint8ClampedArray RGBA bytes, transferable
};

/** Worker → main thread. */
export type RmbgResponse =
  | {
      type: "progress";
      id: number;
      /** Coarse phase label for the UI. */
      stage: "loading_model" | "running";
      /** 0..1 where known, else omitted. */
      progress?: number;
      /** File currently downloading (model warm-up), for nicer status text. */
      file?: string;
    }
  | {
      type: "result";
      id: number;
      /** Single-channel alpha matte, one byte per pixel (0..255). */
      matte: ArrayBuffer;
      width: number;
      height: number;
    }
  | {
      type: "error";
      id: number;
      message: string;
    };
