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
  "relight",
  "color_match",
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

/** Light directions the relighter understands (where the key light comes FROM). */
export const RELIGHT_DIRECTIONS = [
  "left",
  "right",
  "top",
  "bottom",
  "front",
  "behind",
] as const;

export type RelightDirection = (typeof RELIGHT_DIRECTIONS)[number];

export interface RelightInputs {
  /** The active image (composite or layer region) to relight. */
  image: AssetRef;
  /**
   * Where the dominant (key) light comes FROM, relative to the subject:
   * - "left"/"right"  — side light, shapes the subject and casts shadows sideways
   * - "top"           — overhead light
   * - "bottom"        — uplight / footlight
   * - "front"         — flat frontal light (camera-side)
   * - "behind"        — backlight / rim light (subject lit from behind)
   */
  direction: RelightDirection;
  /**
   * Key-light color as a #RRGGBB hex string. Drives the color temperature of the
   * relight. Defaults to a warm white (`#ffe6c0`) when omitted.
   */
  color?: string;
  /**
   * 0..1 — how strong the relight is. 0 ≈ a whisper of directional shaping,
   * 1 ≈ dramatic, high-contrast lighting. Defaults to 0.6 when omitted.
   */
  intensity?: number;
  /**
   * Optional scene/lighting environment to relight INTO (e.g. "golden hour on a
   * beach", "moody neon-lit alley at night"). When given, the relighter changes
   * the background/environment lighting to match while preserving the subject's
   * identity, shapes and composition. When omitted, only the existing scene's
   * light direction/color/contrast change.
   */
  backgroundPrompt?: string;
  seed?: number;
}

export interface ColorMatchInputs {
  /** The active image whose colors will be re-graded. Its alpha is preserved. */
  image: AssetRef;
  /** The reference image whose color grade (palette/tone) is transferred onto `image`. */
  reference: AssetRef;
  /**
   * 0..1 — how much of the reference grade to apply. 0 = original image
   * unchanged, 1 = full Reinhard mean/std transfer. Defaults to 1 when omitted.
   */
  strength?: number;
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
  relight: RelightInputs;
  color_match: ColorMatchInputs;
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

// ──────────────────────────────────────────────────────────────
// Agent ops vocabulary (planner ↔ web executor contract)
//
// The TEXT planner LLM (POST /ai/agent) may only emit ops from AGENT_OPS.
// The web client executor (`useEngine` actions + AI jobs) implements each op
// 1:1 against these names and param shapes. This array is the single source
// of truth shared by: (a) the API system prompt that constrains the LLM,
// (b) the API zod validator that drops unknown ops, and (c) the web executor.
//
// Param `type` strings are documentation/JSON-Schema-ish hints for the LLM —
// they are NOT runtime-enforced shapes (the per-op `params` object is passed
// through opaquely to the matching engine action). Keep them descriptive.
// ──────────────────────────────────────────────────────────────

/** A single tunable input on an agent op, described to the planner LLM. */
export interface AgentOpParam {
  name: string;
  /** A descriptive type hint for the LLM, e.g. "string", "number", "object", "RGBA color". */
  type: string;
  description: string;
  /** When present, the planner must choose one of these literal string values. */
  enum?: readonly string[];
}

/** A capability the planner may compose into a plan. */
export interface AgentOpDef {
  op: string;
  description: string;
  params: AgentOpParam[];
}

/**
 * Adjustment-layer types (mirror of web `engine/adjustments.ts` ADJUSTMENTS).
 * Surfaced as an enum so the planner picks a valid `type` for add_adjustment.
 */
export const AGENT_ADJUSTMENT_TYPES = [
  "brightness_contrast",
  "levels",
  "curves",
  "exposure",
  "vibrance",
  "hue_saturation",
  "color_balance",
  "black_white",
  "photo_filter",
  "channel_mixer",
  "invert",
  "posterize",
  "threshold",
  "gradient_map",
] as const;

/** Filter types (mirror of web `engine/filters.ts` FILTERS). */
export const AGENT_FILTER_TYPES = [
  "gaussian_blur",
  "motion_blur",
  "sharpen",
  "unsharp_mask",
  "add_noise",
  "pixelate",
  "find_edges",
  "emboss",
  "vignette",
  "chromatic_aberration",
  "halftone",
  "lens_blur",
  "oil_paint",
  "clarity",
] as const;

/** Layer-effect types (mirror of web engine LayerEffectType). */
export const AGENT_LAYER_EFFECT_TYPES = [
  "dropShadow",
  "stroke",
  "outerGlow",
  "colorOverlay",
  "innerShadow",
] as const;

/** Generative-fill modes for inpaint_selection (mirror of InpaintInputs.mode). */
export const AGENT_INPAINT_MODES = ["fill", "remove"] as const;

/**
 * The closed set of ops the planner may use. The web executor switches on
 * `op` and reads `params` to dispatch to the matching `useEngine` action or
 * AI job. Ops marked "(AI job)" enqueue an async POST /ai/jobs; the rest are
 * synchronous local engine edits.
 */
export const AGENT_OPS: readonly AgentOpDef[] = [
  {
    op: "add_adjustment",
    description:
      "Add a non-destructive adjustment layer on top of the stack (e.g. boost contrast, shift hue, convert to black & white). Maps to actions.addAdjustmentLayer(type, params).",
    params: [
      {
        name: "type",
        type: "string",
        description: "Which adjustment to add.",
        enum: AGENT_ADJUSTMENT_TYPES,
      },
      {
        name: "params",
        type: "object",
        description:
          "Adjustment-specific settings object, e.g. { brightness: 0.2, contrast: 0.15 } for brightness_contrast, or {} to use sensible defaults. Omit or send {} when unsure.",
      },
    ],
  },
  {
    op: "apply_filter",
    description:
      "Apply a destructive pixel filter to the active raster layer (blur, sharpen, noise, stylize, etc.). Maps to actions.applyFilter(activeLayerId, type, params).",
    params: [
      {
        name: "type",
        type: "string",
        description: "Which filter to apply.",
        enum: AGENT_FILTER_TYPES,
      },
      {
        name: "params",
        type: "object",
        description:
          "Filter-specific settings object, e.g. { radius: 8 } for gaussian_blur, or {} for defaults.",
      },
    ],
  },
  {
    op: "add_layer_effect",
    description:
      "Add or update a layer effect (a.k.a. layer style) on the active layer, e.g. a drop shadow or stroke. Maps to actions.updateLayerEffect(activeLayerId, type, params).",
    params: [
      {
        name: "type",
        type: "string",
        description: "Which layer effect to add or update.",
        enum: AGENT_LAYER_EFFECT_TYPES,
      },
      {
        name: "params",
        type: "object",
        description:
          "Effect-specific patch object, e.g. { enabled: true, distance: 8, opacity: 0.5 } for dropShadow, or {} for defaults.",
      },
    ],
  },
  {
    op: "image_edit_composite",
    description:
      "Edit the ENTIRE visible image by natural-language instruction (\"edit by chatting\"). The full composite PNG is sent to the image model and replaced with the result. Use for global, content-aware edits that no adjustment/filter can express (e.g. \"make it snowy\", \"change the car to red\"). Runs as an async AI job.",
    params: [
      {
        name: "instruction",
        type: "string",
        description:
          "Plain-language description of the desired change to the whole image.",
      },
    ],
  },
  {
    op: "generate_layer",
    description:
      "Generate a brand-new image from a text prompt and place it as a new layer (text-to-image). Runs as an async AI job.",
    params: [
      {
        name: "prompt",
        type: "string",
        description: "Text prompt describing the image to generate.",
      },
    ],
  },
  {
    op: "remove_background",
    description:
      "Remove the background of the active layer, leaving the subject on transparency (client-side RMBG, or server fallback).",
    params: [],
  },
  {
    op: "inpaint_selection",
    description:
      "Regenerate or erase the CURRENTLY SELECTED region using a prompt (generative fill / object removal). Requires an active selection (context.hasSelection must be true). Runs as an async AI job.",
    params: [
      {
        name: "prompt",
        type: "string",
        description:
          "What to fill the selection with. May be empty when mode is \"remove\".",
      },
      {
        name: "mode",
        type: "string",
        description:
          "\"fill\" replaces the selection with the prompt; \"remove\" erases an object and reconstructs the background.",
        enum: AGENT_INPAINT_MODES,
      },
    ],
  },
  {
    op: "fill",
    description:
      "Fill the current selection (or the whole active layer if there is no selection) with a solid color. Maps to actions.fillSelection(color).",
    params: [
      {
        name: "color",
        type: "string",
        description:
          "Fill color as a #RRGGBB or #RRGGBBAA hex string (e.g. \"#ff0000\").",
      },
    ],
  },
  {
    op: "select_all",
    description: "Select the entire canvas. Maps to actions.selectAll().",
    params: [],
  },
  {
    op: "deselect",
    description:
      "Clear the current selection. Maps to actions.clearSelection().",
    params: [],
  },
  {
    op: "invert_selection",
    description:
      "Invert the current selection. Maps to actions.invertSelection().",
    params: [],
  },
  {
    op: "set_foreground",
    description:
      "Set the foreground (paint) color. Maps to actions.setForeground(color).",
    params: [
      {
        name: "color",
        type: "string",
        description:
          "Foreground color as a #RRGGBB or #RRGGBBAA hex string (e.g. \"#00aaff\").",
      },
    ],
  },
] as const;

/** All valid op names, derived from AGENT_OPS (used for validation). */
export const AGENT_OP_NAMES: readonly string[] = AGENT_OPS.map((o) => o.op);

/** One planned step the web executor runs. */
export interface AgentStep {
  /** Must be one of AGENT_OP_NAMES. */
  op: string;
  /** Concrete params for this op (shape depends on `op`; see AGENT_OPS). */
  params: Record<string, unknown>;
  /** Optional short explanation of why this step is included. */
  rationale?: string;
}

/**
 * The planner's output. Either a list of executable steps, or (when the goal
 * is ambiguous / impossible) an empty `steps` array plus a clarifying
 * `message` to show the user.
 */
export interface AgentPlan {
  steps: AgentStep[];
  /** Clarifying question or summary message for the user. */
  message?: string;
}

/** Snapshot of editor state the planner uses to ground its plan. */
export interface AgentContext {
  /** Number of layers currently in the document. */
  layers?: number;
  /** Whether there is an active pixel selection (gates inpaint_selection). */
  hasSelection?: boolean;
  /** Kind of the active layer, e.g. "raster" | "adjustment" | "text" | "smart". */
  activeLayerKind?: string;
}

/** Request body for POST /ai/agent. */
export interface AgentRequest {
  /** The user's natural-language goal. */
  goal: string;
  context?: AgentContext;
}

/** Response body for POST /ai/agent (synchronous text-model call). */
export interface AgentResponse {
  plan: AgentPlan;
}
