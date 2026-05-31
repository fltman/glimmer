/**
 * @aips/shared-types — the cross-package contract.
 *
 * Consumed by `web` (browser client) and `api` (Fastify). The Python `workers`
 * package mirrors these shapes in `workers/aips/contracts.py` — keep them in sync.
 *
 * Phase 0/1 scope: jobs, the AI capability set, presigned uploads, and the
 * WebSocket progress protocol. Editor document/layer types live in `web` for now;
 * only what crosses the wire belongs here.
 */

// ──────────────────────────────────────────────────────────────
// AI capabilities
// ──────────────────────────────────────────────────────────────

/**
 * The closed set of AI operations the product offers. `inpaint`/`outpaint` are
 * "virtual" — implemented by a backend pipeline that calls a provider's
 * `image_edit`, not a native endpoint.
 */
export const CAPABILITIES = [
  "text_to_image",
  "image_edit",
  "inpaint",
  "outpaint",
  "segment",
  "upscale",
  "remove_background",
  "harmonize",
] as const;

export type Capability = (typeof CAPABILITIES)[number];

/** Where a capability can be executed. */
export type ExecutionLocation = "server" | "client";

// ──────────────────────────────────────────────────────────────
// Capability inputs (discriminated by `capability`)
// ──────────────────────────────────────────────────────────────

/** Reference to a binary asset already uploaded to object storage. */
export interface AssetRef {
  /** Object storage key (e.g. `u/<user>/<sha256>.png`). */
  key: string;
  /** sha256 hex of the bytes — used for content-addressed dedup. */
  sha256: string;
  contentType: string;
  width?: number;
  height?: number;
}

/** A rectangle in document pixel space. */
export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface TextToImageInputs {
  prompt: string;
  negativePrompt?: string;
  /** Target dimensions; provider may snap to nearest supported bucket. */
  width?: number;
  height?: number;
  seed?: number;
}

export interface ImageEditInputs {
  image: AssetRef;
  instruction: string;
  seed?: number;
}

export interface InpaintInputs {
  /** The source layer/composite ROI to edit. */
  image: AssetRef;
  /** Single-channel mask PNG; white = regenerate. Same dimensions as `image`. */
  mask: AssetRef;
  prompt: string;
  /** "fill" replaces masked content with the prompt; "remove" erases an object. */
  mode: "fill" | "remove";
  /** ROI offset/scale in the original document, so the result can be placed back. */
  roi: Rect;
  /**
   * Optional reference image for generative fill: the masked region is filled
   * with the object/appearance shown here (identity preserved, scale/perspective/
   * lighting adapted to the scene). The text `prompt` becomes optional in spirit
   * when a reference is supplied, but the wire schema still requires a string —
   * send an empty string if you have nothing to add.
   */
  referenceImage?: AssetRef;
  seed?: number;
}

export interface HarmonizeInputs {
  /**
   * The inserted subject as an RGBA cutout (its alpha channel defines the
   * subject silhouette). Same pixel dimensions as `background`.
   */
  foreground: AssetRef;
  /**
   * Flattened composite of the layers BELOW the subject (the scene the subject
   * is being dropped into). Same pixel dimensions as `foreground`.
   */
  background: AssetRef;
  /** Optional region of interest the subject occupies, for placing the result back. */
  roi?: Rect;
  /** 0..1 — how aggressively to relight/grade the subject (default ~0.6). */
  strength?: number;
  seed?: number;
}

export interface OutpaintInputs {
  image: AssetRef;
  /** Pixels to add on each side of the source image. */
  expand: { top: number; right: number; bottom: number; left: number };
  prompt?: string;
  seed?: number;
}

export interface SegmentInputs {
  image: AssetRef;
  /** Optional prompt point/box hints in image space. */
  points?: { x: number; y: number; label: 0 | 1 }[];
  box?: Rect;
}

export interface UpscaleInputs {
  image: AssetRef;
  scale: 2 | 4;
  /**
   * 0..1 — creative-enhance strength applied AFTER the base upscale. 0 (or
   * omitted) = pure resample, no invented detail. Higher values run a Gemini
   * img2img "enhance" pass that sharpens textures and synthesizes fine detail;
   * the result is color-matched back to the base upscale to avoid drift.
   */
  creativity?: number;
}

export interface RemoveBackgroundInputs {
  image: AssetRef;
}

export interface CapabilityInputsMap {
  text_to_image: TextToImageInputs;
  image_edit: ImageEditInputs;
  inpaint: InpaintInputs;
  outpaint: OutpaintInputs;
  segment: SegmentInputs;
  upscale: UpscaleInputs;
  remove_background: RemoveBackgroundInputs;
  harmonize: HarmonizeInputs;
}

// ──────────────────────────────────────────────────────────────
// Jobs
// ──────────────────────────────────────────────────────────────

export type JobStatus =
  | "queued"
  | "running"
  | "succeeded"
  | "failed"
  | "canceled";

export type JobProgressStage =
  | "queued"
  | "uploading_input"
  | "calling_model"
  | "post_processing"
  | "done";

/** Request body for POST /ai/jobs (generic over capability). */
export interface CreateJobRequest<C extends Capability = Capability> {
  capability: C;
  inputs: CapabilityInputsMap[C];
  documentId?: string;
  /** Quality vs latency hint. */
  qualityTier?: "fast" | "quality";
  /** Routing hint; the server has final say. */
  preferLocation?: ExecutionLocation;
  /**
   * Stable hash of the logical action {capability, inputs, seed}. Re-posting the
   * same key returns the existing job (no duplicate provider charge).
   */
  idempotencyKey: string;
}

/** An output artifact produced by a job, referenced by a presigned GET URL. */
export interface JobArtifact {
  kind: "image" | "mask" | "preview";
  url: string;
  contentType: string;
  width?: number;
  height?: number;
  /** Where to place the result in the document, if applicable. */
  placement?: { roi: Rect; suggestedLayerName?: string };
}

export interface Job {
  id: string;
  capability: Capability;
  status: JobStatus;
  progress: number; // 0..1
  stage: JobProgressStage;
  providerResolved?: string;
  artifacts: JobArtifact[];
  costUsd?: number;
  error?: { code: string; message: string };
  createdAt: string; // ISO 8601
  finishedAt?: string;
}

/**
 * Response to POST /ai/jobs. Either a server job handle to poll/subscribe, OR a
 * directive telling the client to run the op locally (client-preferred path).
 */
export type CreateJobResponse =
  | { kind: "job"; job: Job }
  | {
      kind: "client_directive";
      capability: Capability;
      /** e.g. "RMBG-1.4" */
      model: string;
      /** Presigned URL to download the ONNX weights (cached by the browser). */
      weightsUrl: string;
    };

// ──────────────────────────────────────────────────────────────
// Presigned uploads
// ──────────────────────────────────────────────────────────────

export interface PresignUploadRequest {
  sha256: string;
  contentType: string;
  byteLength: number;
}

export interface PresignUploadResponse {
  /** If the object already exists (dedup hit), `alreadyExists` is true and no PUT is needed. */
  alreadyExists: boolean;
  key: string;
  /** Presigned PUT URL (null when alreadyExists). */
  uploadUrl: string | null;
  /** Headers the client must send with the PUT. */
  requiredHeaders: Record<string, string>;
}

// ──────────────────────────────────────────────────────────────
// Client capability profile (client-preferred handshake)
// ──────────────────────────────────────────────────────────────

export interface ClientCapabilities {
  webgpu: boolean;
  wasmSimd: boolean;
  wasmThreads: boolean;
  deviceMemoryGb?: number;
  /** True once the browser has warmed up the RMBG model successfully. */
  rmbgReady: boolean;
}

// ──────────────────────────────────────────────────────────────
// WebSocket progress protocol
// ──────────────────────────────────────────────────────────────

/** Server → client messages on the job progress socket. */
export type ServerWsMessage =
  | { type: "job_update"; job: Job }
  | { type: "error"; jobId?: string; code: string; message: string }
  | { type: "pong" };

/** Client → server messages. */
export type ClientWsMessage =
  | { type: "subscribe"; jobId: string }
  | { type: "unsubscribe"; jobId: string }
  | { type: "ping" };

// ──────────────────────────────────────────────────────────────
// Internal queue contract (API → Redis → Celery)
// The Python worker mirrors this in contracts.py.
// ──────────────────────────────────────────────────────────────

export interface QueuedJobPayload {
  jobId: string;
  capability: Capability;
  inputs: unknown; // validated CapabilityInputsMap[C] at the boundary
  userId: string;
  idempotencyKey: string;
}

/** Redis pub/sub channel for a job's progress. */
export const jobChannel = (jobId: string): string => `job:${jobId}`;
