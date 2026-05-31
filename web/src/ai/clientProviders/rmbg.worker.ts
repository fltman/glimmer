/// <reference lib="webworker" />
/**
 * RMBG-1.4 background-removal Web Worker.
 *
 * Lazy-loads briaai/RMBG-1.4 (Transformers.js v3) on first request and caches
 * the model + processor for the worker's lifetime (transformers.js also caches
 * the weights in the browser Cache API automatically). Prefers the WebGPU
 * device, falling back to wasm. Runs inference on an input bitmap and returns a
 * single-channel alpha matte (Uint8) sized to the input. Progress (model
 * download + inference phases) is reported via postMessage.
 *
 * Follows the official transformers.js "background-removal" example: AutoModel
 * + AutoProcessor + RawImage, model output is a single-channel mask that we
 * bilinearly resize back to the original dimensions.
 */
import {
  AutoModel,
  AutoProcessor,
  RawImage,
  env,
  type PreTrainedModel,
  type Processor,
} from "@huggingface/transformers";
import type { RmbgRequest, RmbgResponse } from "./rmbgProtocol";

// Always allow remote weights from the HF CDN (the server's client_directive
// points at a not-yet-seeded MinIO object, which we intentionally ignore).
env.allowRemoteModels = true;
env.allowLocalModels = false;

const MODEL_ID = "briaai/RMBG-1.4";

let modelPromise: Promise<{ model: PreTrainedModel; processor: Processor }> | null =
  null;
let resolvedDevice: "webgpu" | "wasm" = "wasm";

const ctx = self as unknown as DedicatedWorkerGlobalScope;

function post(msg: RmbgResponse, transfer?: Transferable[]): void {
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

/** Load (or reuse) the model + processor, reporting download progress. */
function loadModel(
  id: number,
): Promise<{ model: PreTrainedModel; processor: Processor }> {
  if (modelPromise) return modelPromise;
  modelPromise = (async () => {
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
    const model = await AutoModel.from_pretrained(MODEL_ID, {
      // fp32 on wasm; fp16 is fine on WebGPU but fp32 is the safe default for
      // a small matting net and avoids precision artefacts on the matte.
      device: resolvedDevice,
      progress_callback: progressCallback,
    });
    const processor = await AutoProcessor.from_pretrained(MODEL_ID, {
      progress_callback: progressCallback,
    });
    return { model, processor };
  })();
  return modelPromise;
}

async function run(req: RmbgRequest): Promise<void> {
  const { id, width, height, pixels } = req;
  try {
    const { model, processor } = await loadModel(id);

    post({ type: "progress", id, stage: "running", progress: 0 });

    // Build a RawImage from the transferred RGBA bytes. RawImage stores
    // channel-last data; 4 channels (RGBA) is accepted and the processor
    // normalizes to the model's expected input.
    const rgba = new Uint8ClampedArray(pixels);
    const image = new RawImage(
      new Uint8ClampedArray(rgba.buffer.slice(0)),
      width,
      height,
      4,
    );

    // Preprocess → model → single-channel matte. Mirrors the official
    // transformers.js background-removal example: the processor resizes to the
    // model's expected input, the model returns a [1,1,H,W] matte already in
    // [0,1] (no extra sigmoid), which we scale to bytes and resize back.
    const { pixel_values } = await processor(image);
    const output = await model({ input: pixel_values });

    // RMBG-1.4 exposes the matte on the first output tensor (the export's name
    // varies across revisions); grab it robustly.
    const firstKey = Object.keys(output)[0]!;
    let maskTensor = output[firstKey];

    // The matte is exported as a 4-D [B,1,H,W] tensor; RawImage.fromTensor
    // REQUIRES exactly 3 dims (C,H,W) and throws otherwise. Squeeze the leading
    // singleton dims (batch, and any extra channel axis > 1 isn't expected for
    // a single-channel matte) until we reach 3-D. This mirrors the official
    // transformers.js background-removal example's `output[0]`.
    while (maskTensor.dims.length > 3 && maskTensor.dims[0] === 1) {
      maskTensor = maskTensor.squeeze(0);
    }

    const maskImage = RawImage.fromTensor(maskTensor.mul(255).to("uint8"));
    const resized = await maskImage.resize(width, height);

    post({ type: "progress", id, stage: "running", progress: 1 });

    // resized.data is channel-last; the matte is single-channel but be robust
    // to a stray channel count by sampling the first channel per pixel.
    const matteSrc = resized.data as Uint8Array | Uint8ClampedArray;
    const channels = resized.channels;
    const matte = new Uint8Array(width * height);
    if (channels === 1) {
      matte.set(matteSrc.subarray(0, width * height));
    } else {
      for (let i = 0; i < width * height; i++) {
        matte[i] = matteSrc[i * channels] ?? 0;
      }
    }

    const buf = matte.buffer as ArrayBuffer;
    post({ type: "result", id, matte: buf, width, height }, [buf]);
  } catch (err) {
    post({
      type: "error",
      id,
      message: err instanceof Error ? err.message : String(err),
    });
  }
}

ctx.addEventListener("message", (ev: MessageEvent<RmbgRequest>) => {
  const msg = ev.data;
  if (msg && msg.type === "run") void run(msg);
});

export {};
