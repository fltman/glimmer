/// <reference lib="webworker" />
/**
 * Segment-Anything (SlimSAM) "click to select" Web Worker.
 *
 * Lazy-loads Xenova/slimsam-77-uniform (a small, web-friendly SAM distillation)
 * via Transformers.js v3 and caches the model + processor for the worker's
 * lifetime. Prefers the WebGPU device, falling back to wasm. Mirrors the
 * rmbg.worker structure (lazy load, progress postMessage, transferable buffers).
 *
 * SAM is two-phase:
 *   1. set_image → run the (heavy) vision encoder ONCE and cache the image
 *      embeddings + positional embeddings + the processor's reshaped/original
 *      sizes + the source RawImage for this image.
 *   2. segment(points, box) → re-run the (cheap) processor with the point/box
 *      prompt so it reshapes the coords into the model's input space, then run
 *      the mask decoder with the CACHED embeddings (the encoder is skipped),
 *      pick the highest-scoring of the 3 masks, post-process it back to the
 *      original image resolution, and return a single-channel Uint8 alpha mask.
 *
 * Follows the official transformers.js SAM example: SamModel.from_pretrained +
 * AutoProcessor.from_pretrained, processor(image, { input_points, input_labels,
 * input_boxes }), model.get_image_embeddings, model(inputs), post_process_masks.
 */
import {
  SamModel,
  AutoProcessor,
  RawImage,
  env,
  type PreTrainedModel,
  type Processor,
  type Tensor,
} from "@huggingface/transformers";
import type { SamRequest, SamResponse, SamPoint, SamBox } from "./samProtocol";

// Always allow remote weights from the HF CDN (same rationale as rmbg.worker).
env.allowRemoteModels = true;
env.allowLocalModels = false;

const MODEL_ID = "Xenova/slimsam-77-uniform";

let modelPromise: Promise<{ model: PreTrainedModel; processor: Processor }> | null =
  null;
let resolvedDevice: "webgpu" | "wasm" = "wasm";

/** Cached per-image state from the most recent set_image. */
interface ImageState {
  width: number;
  height: number;
  /** The source image (kept so the processor can reshape prompts per click). */
  image: RawImage;
  /** Vision-encoder outputs (decoder inputs); the heavy step we run once. */
  imageEmbeddings: Tensor;
  imagePositionalEmbeddings: Tensor;
}
let imageState: ImageState | null = null;

const ctx = self as unknown as DedicatedWorkerGlobalScope;

function post(msg: SamResponse, transfer?: Transferable[]): void {
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

/** Load (or reuse) the SAM model + processor, reporting download progress. */
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
    const model = await SamModel.from_pretrained(MODEL_ID, {
      // fp32 is the safe default: the encoder is precision sensitive and
      // SlimSAM is small enough that fp32 stays fast.
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

/** The SamModel exposes get_image_embeddings; type it narrowly here. */
type SamModelLike = PreTrainedModel & {
  get_image_embeddings(inputs: { pixel_values: Tensor }): Promise<{
    image_embeddings: Tensor;
    image_positional_embeddings: Tensor;
  }>;
};
/** The SamProcessor accepts prompt options + post_process_masks. */
type SamProcessorLike = Processor & {
  (
    image: RawImage,
    opts?: {
      input_points?: number[][][];
      input_labels?: number[][];
      input_boxes?: number[][][];
    },
  ): Promise<{
    pixel_values: Tensor;
    original_sizes: [number, number][];
    reshaped_input_sizes: [number, number][];
    input_points?: Tensor;
    input_labels?: Tensor;
    input_boxes?: Tensor;
  }>;
  post_process_masks(
    masks: Tensor,
    original_sizes: [number, number][],
    reshaped_input_sizes: [number, number][],
  ): Promise<Tensor[]>;
};

/** Phase 1: encode an image and cache its embeddings + source. */
async function setImage(
  req: Extract<SamRequest, { type: "set_image" }>,
): Promise<void> {
  const { id, width, height, pixels } = req;
  try {
    const { model, processor } = await loadModel(id);
    post({ type: "progress", id, stage: "encoding", progress: 0 });

    const rgba = new Uint8ClampedArray(pixels);
    // SAM wants RGB; build a 3-channel RawImage from the RGBA bytes.
    const rgb = new Uint8ClampedArray(width * height * 3);
    for (let i = 0, p = 0, q = 0; i < width * height; i++, p += 4, q += 3) {
      rgb[q] = rgba[p]!;
      rgb[q + 1] = rgba[p + 1]!;
      rgb[q + 2] = rgba[p + 2]!;
    }
    const image = new RawImage(rgb, width, height, 3);

    const proc = processor as SamProcessorLike;
    const inputs = await proc(image);
    const { image_embeddings, image_positional_embeddings } = await (
      model as SamModelLike
    ).get_image_embeddings({ pixel_values: inputs.pixel_values });

    imageState = {
      width,
      height,
      image,
      imageEmbeddings: image_embeddings,
      imagePositionalEmbeddings: image_positional_embeddings,
    };

    post({ type: "progress", id, stage: "encoding", progress: 1 });
    post({ type: "image_ready", id, width, height });
  } catch (err) {
    imageState = null;
    post({
      type: "error",
      id,
      message: err instanceof Error ? err.message : String(err),
    });
  }
}

/** Phase 2: decode a mask for the current image given a point/box prompt. */
async function segment(
  req: Extract<SamRequest, { type: "segment" }>,
): Promise<void> {
  const { id, points, box } = req;
  try {
    if (!imageState) throw new Error("SAM: no image set (call setImage first).");
    if (!points.length && !box)
      throw new Error("SAM: need at least one point or a box.");
    const { model, processor } = await loadModel(id);
    const proc = processor as SamProcessorLike;
    post({ type: "progress", id, stage: "decoding", progress: 0 });

    // Re-run the processor with the prompt so it reshapes the IMAGE-px coords
    // into the model's resized input space. The encoder is NOT re-run — we pass
    // the cached embeddings to the model below. (Running the processor again is
    // cheap: it only re-preprocesses the image + reshapes the few prompt pts.)
    const input_points: number[][][] = [
      points.map((p: SamPoint) => [p.x, p.y]),
    ];
    const input_labels: number[][] = [points.map((p: SamPoint) => p.label)];
    const promptOpts: {
      input_points?: number[][][];
      input_labels?: number[][];
      input_boxes?: number[][][];
    } = {};
    if (points.length) {
      promptOpts.input_points = input_points;
      promptOpts.input_labels = input_labels;
    }
    if (box) {
      const b: SamBox = box;
      promptOpts.input_boxes = [[[b.x0, b.y0, b.x1, b.y1]]];
    }
    const inputs = await proc(imageState.image, promptOpts);

    const outputs = await (model as unknown as (m: unknown) => Promise<{
      pred_masks: Tensor;
      iou_scores: Tensor;
    }>)({
      image_embeddings: imageState.imageEmbeddings,
      image_positional_embeddings: imageState.imagePositionalEmbeddings,
      input_points: inputs.input_points,
      input_labels: inputs.input_labels,
      input_boxes: inputs.input_boxes,
    });

    // post_process_masks upsamples + removes padding back to original res.
    const masks = await proc.post_process_masks(
      outputs.pred_masks,
      inputs.original_sizes,
      inputs.reshaped_input_sizes,
    );

    // masks[0]: Tensor [batch=1, num_masks, H, W] (bool). iou_scores:
    // [1, 1, num_masks]; pick the highest-scoring mask plane.
    const maskTensor = masks[0] as {
      dims: number[];
      data: Uint8Array | Float32Array | Int8Array;
    };
    const md = maskTensor.dims;
    const numMasks = md[md.length - 3]!;
    const H = md[md.length - 2]!;
    const W = md[md.length - 1]!;
    const scores = (outputs.iou_scores as { data: Float32Array }).data;
    let best = 0;
    let bestScore = -Infinity;
    for (let i = 0; i < numMasks; i++) {
      const s = Number(scores[i] ?? 0);
      if (s > bestScore) {
        bestScore = s;
        best = i;
      }
    }

    const plane = maskTensor.data;
    const out = new Uint8Array(W * H);
    const offset = best * W * H;
    for (let i = 0; i < W * H; i++) {
      out[i] = Number(plane[offset + i] ?? 0) > 0 ? 255 : 0;
    }

    post({ type: "progress", id, stage: "decoding", progress: 1 });
    const buf = out.buffer as ArrayBuffer;
    post(
      { type: "mask", id, mask: buf, width: W, height: H, score: bestScore },
      [buf],
    );
  } catch (err) {
    post({
      type: "error",
      id,
      message: err instanceof Error ? err.message : String(err),
    });
  }
}

ctx.addEventListener("message", (ev: MessageEvent<SamRequest>) => {
  const msg = ev.data;
  if (!msg) return;
  if (msg.type === "set_image") void setImage(msg);
  else if (msg.type === "segment") void segment(msg);
});

export {};
