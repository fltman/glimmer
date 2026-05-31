/**
 * Agent plan EXECUTOR — the bridge between the TEXT planner's AgentPlan
 * (POST /ai/agent) and the real editor: every AGENT_OPS op is mapped 1:1 to a
 * `useEngine` action or an AI job here.
 *
 * DESIGN — no React in this module. The executor is pure async. The chat panel
 * (a React component) constructs an `ExecutorHelpers` object that wires in the
 * singleton `engine`, the `actions` bag, the job `apiClient`, and a
 * useAiJob-style `runJob` runner, then calls `executePlan`. That keeps the
 * mapping logic testable and free of hooks, and means the panel owns all UI
 * state (progress, errors) via the helpers it injects.
 *
 * SEQUENCING — `executePlan` runs steps one at a time and AWAITS each before
 * starting the next. Synchronous engine edits (adjustments, filters, fill,
 * selection ops) resolve immediately; AI-job ops (image_edit_composite,
 * generate_layer, remove_background, inpaint_selection) resolve only once the
 * job is terminal (result placed as a layer / errored). So "make it snowy, then
 * boost contrast" applies the contrast to the snowy result, not the original.
 *
 * ERROR POLICY — a single step that throws is reported (ok:false) but does NOT
 * abort the plan: later steps still run. Rationale: a plan is a best-effort
 * batch of largely-independent edits; if "add a drop shadow" fails because the
 * active layer changed, the user still wants the "convert to B&W" step. The
 * caller gets a per-step result list and can surface partial success. Unknown
 * ops (which the backend already drops) are skipped with ok:false defensively.
 */
import type {
  AgentPlan,
  AgentStep,
  AssetRef,
  CreateJobRequest,
  Capability,
  InpaintInputs,
  JobArtifact,
  Rect,
} from "@aips/shared-types";
import { AGENT_OP_NAMES } from "@aips/shared-types";
import type { AdjustmentType } from "../../engine/adjustments";
import type { FilterType } from "../../engine/filters";
import type { LayerEffectType } from "../../model/Document";
import type { RGBAColor } from "../../state/tools";

// ──────────────────────────────────────────────────────────────
// Injected dependency surface (built by the chat panel; no React here)
// ──────────────────────────────────────────────────────────────

/** A document-space rectangle. */
export type Geometry = { x: number; y: number; width: number; height: number };

/**
 * The subset of `useEngine` `actions` + `engine` the executor calls. Narrowed
 * to exactly what the ops need so the panel can inject the real singletons (or
 * a fake, in tests) without pulling the whole engine type in.
 */
export interface ExecutorEngine {
  /** Add a non-destructive adjustment layer; returns the new layer id. */
  addAdjustmentLayer(type: AdjustmentType, params?: Record<string, unknown>): string;
  /** Apply a destructive filter to a raster layer. */
  applyFilter(layerId: string, type: FilterType, params?: Record<string, unknown>): void;
  /** Add/update a layer effect on a layer. */
  updateLayerEffect(id: string, type: LayerEffectType, patch: Record<string, unknown>): void;
  /** Fill the active layer's selection (or whole layer) with a color. */
  fillSelection(c: RGBAColor, layerId?: string): void;
  /** Set the foreground (paint) color. */
  setForeground(c: RGBAColor): void;
  selectAll(): void;
  clearSelection(): void;
  invertSelection(): void;

  /** Active layer id (any kind), or null. */
  getActiveLayerId(): string | null;
  /** Active layer id IFF it is a raster layer, else null. */
  getActiveRasterLayerId(): string | null;
  /**
   * A raster layer to apply a GLOBAL filter to: the active layer if it is
   * raster, else the topmost raster layer in the document, else null. Filters
   * planned by the agent ("add a vignette") target image pixels — but a plan
   * usually adds adjustment layers first, leaving a non-raster layer active, so
   * resolving to the top raster keeps those steps from silently no-op'ing.
   */
  getFilterTargetLayerId(): string | null;
  /** Is there a non-empty pixel selection? */
  hasSelection(): boolean;
  /** Tight doc-space bounds of the current selection, or null. */
  getSelectionMaskBounds(): Geometry | null;
  /** Doc-space geometry of a layer, or null. */
  getLayerGeometry(id: string): Geometry | null;

  /** Flatten the whole document to a PNG Blob (alpha preserved). */
  exportComposite(): Promise<Blob>;
  /** Export a layer's composited pixels within an ROI as a PNG. */
  exportLayerRegionPNG(layerId: string, roi: Geometry): Promise<Blob>;
  /** Export the selection mask within an ROI (white = selected) as a PNG. */
  exportSelectionMaskPNG(roi?: Geometry): Promise<Blob>;

  /** Add an image Blob as a NEW raster layer; returns the new layer id. */
  loadImageLayer(src: Blob, name?: string): Promise<string>;
  /** Place a layer at an absolute document position. */
  setLayerPosition(id: string, x: number, y: number): void;
}

/** Where to place a completed job's primary image artifact. */
export type PlaceArtifact = (blob: Blob, artifact: JobArtifact) => Promise<void> | void;

/**
 * A useAiJob-style runner. Submits a job and resolves ONLY when it is terminal:
 * a succeeded job has had `place` awaited; a failed/canceled job rejects. For
 * client-preferred capabilities (remove_background) the runner may handle the
 * client_directive itself (run RMBG locally) via `onClientDirective`.
 *
 * The panel implements this with the existing `useAiJob` hook (or a direct
 * apiClient flow), so the executor never touches React or WebSockets.
 */
export type RunJob = <C extends Capability>(
  req: CreateJobRequest<C>,
  opts: {
    onArtifact: PlaceArtifact;
    onClientDirective?: () => Promise<void> | void;
  },
) => Promise<void>;

/** Build a stable idempotency key (sha256 of the logical action). */
export type IdempotencyKey = (parts: unknown) => Promise<string>;

/** Presign + upload a Blob, returning the AssetRef jobs reference. */
export type PresignUpload = (file: Blob) => Promise<AssetRef>;

/**
 * Everything the executor needs, injected by the chat panel. Keeping these as a
 * flat bag (rather than reaching into module singletons) is what lets the
 * executor stay React-free and unit-testable.
 */
export interface ExecutorHelpers {
  engine: ExecutorEngine;
  presignUpload: PresignUpload;
  idempotencyKey: IdempotencyKey;
  runJob: RunJob;
}

// ──────────────────────────────────────────────────────────────
// Results
// ──────────────────────────────────────────────────────────────

export interface StepResult {
  op: string;
  ok: boolean;
  /** Human-readable summary (success note or failure reason). */
  message: string;
  /** True for AI-job ops (image_edit_composite, generate_layer, …). */
  isJob: boolean;
}

export interface PlanResult {
  results: StepResult[];
  /** True when every executed step reported ok. */
  ok: boolean;
  /** Count of steps that reported ok. */
  succeeded: number;
  /** Count of steps that reported a failure (incl. skipped unknown ops). */
  failed: number;
}

/** Progress callback: fired once per step before it runs, and after it settles. */
export interface ProgressEvent {
  /** Index of this step in the plan. */
  index: number;
  /** Total steps in the plan. */
  total: number;
  step: AgentStep;
  /** "start" before running, "settle" after the result is known. */
  phase: "start" | "settle";
  /** Present on "settle". */
  result?: StepResult;
}
export type OnProgress = (e: ProgressEvent) => void;

// ──────────────────────────────────────────────────────────────
// Small param helpers (defensive — params come from an LLM)
// ──────────────────────────────────────────────────────────────

function asObject(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : {};
}

function asString(v: unknown): string | null {
  return typeof v === "string" ? v : null;
}

/**
 * Parse a #RGB / #RGBA / #RRGGBB / #RRGGBBAA hex string into the engine's
 * float RGBAColor ({r,g,b,a} in 0..1). Returns null on anything unparseable
 * (the caller then fails the step rather than filling with garbage).
 *
 * Local copy (not the ui/adjustments colorUtil) so this module stays within the
 * agent/ scope and free of UI deps.
 */
export function parseHexColor(input: unknown): RGBAColor | null {
  const s = asString(input);
  if (!s) return null;
  let hex = s.trim().replace(/^#/, "");
  // Expand shorthand #rgb / #rgba to full form.
  if (hex.length === 3 || hex.length === 4) {
    hex = hex
      .split("")
      .map((c) => c + c)
      .join("");
  }
  if (hex.length !== 6 && hex.length !== 8) return null;
  if (!/^[0-9a-fA-F]+$/.test(hex)) return null;
  const r = parseInt(hex.slice(0, 2), 16) / 255;
  const g = parseInt(hex.slice(2, 4), 16) / 255;
  const b = parseInt(hex.slice(4, 6), 16) / 255;
  const a = hex.length === 8 ? parseInt(hex.slice(6, 8), 16) / 255 : 1;
  return { r, g, b, a };
}

// ──────────────────────────────────────────────────────────────
// Op handlers
// ──────────────────────────────────────────────────────────────

type OpHandler = (
  params: Record<string, unknown>,
  helpers: ExecutorHelpers,
) => Promise<{ ok: boolean; message: string }>;

/** Adjustment/filter/effect ops carry a string `type` that must be in this set. */
function requireEnum<T extends string>(
  value: unknown,
  allowed: readonly T[],
  label: string,
): T {
  const s = asString(value);
  if (s && (allowed as readonly string[]).includes(s)) return s as T;
  throw new Error(`Missing or invalid "${label}" (got ${JSON.stringify(value)}).`);
}

const ADJUSTMENT_TYPES = [
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
] as const satisfies readonly AdjustmentType[];

const FILTER_TYPES = [
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
] as const satisfies readonly FilterType[];

const EFFECT_TYPES = [
  "dropShadow",
  "stroke",
  "outerGlow",
  "colorOverlay",
  "innerShadow",
] as const satisfies readonly LayerEffectType[];

/**
 * The op map: AGENT_OPS op name → handler. Exported so the chat panel can
 * display the supported set, and so tests can drive a single op directly.
 *
 * SYNC handlers mutate the engine and resolve immediately. JOB handlers enqueue
 * via helpers.runJob and resolve once the job is terminal (result placed).
 */
export const OP_HANDLERS: Record<string, OpHandler> = {
  // ── 1. add_adjustment (SYNC) ──
  async add_adjustment(params, { engine }) {
    const type = requireEnum(params.type, ADJUSTMENT_TYPES, "type");
    engine.addAdjustmentLayer(type, asObject(params.params));
    return { ok: true, message: `Added ${type.replace(/_/g, " ")} adjustment.` };
  },

  // ── 2. apply_filter (SYNC) ──
  async apply_filter(params, { engine }) {
    const type = requireEnum(params.type, FILTER_TYPES, "type");
    // Target the active layer if it is raster, else fall back to the topmost
    // raster layer — a plan that added adjustment layers earlier leaves a
    // non-raster layer active, and the filter should still hit real pixels.
    const layerId = engine.getFilterTargetLayerId();
    if (!layerId) {
      return {
        ok: false,
        message: `Can't apply ${type.replace(/_/g, " ")}: the document has no raster layer.`,
      };
    }
    engine.applyFilter(layerId, type, asObject(params.params));
    return { ok: true, message: `Applied ${type.replace(/_/g, " ")} filter.` };
  },

  // ── 3. add_layer_effect (SYNC) ──
  async add_layer_effect(params, { engine }) {
    const type = requireEnum(params.type, EFFECT_TYPES, "type");
    const id = engine.getActiveLayerId();
    if (!id) return { ok: false, message: "No active layer to add the effect to." };
    // Default `enabled: true` so the effect is visible without the LLM having to
    // remember to enable it (the engine merges this patch onto effect defaults).
    const patch = { enabled: true, ...asObject(params.params) };
    engine.updateLayerEffect(id, type, patch);
    return { ok: true, message: `Added ${type} layer effect.` };
  },

  // ── 4. image_edit_composite (AI JOB) — "edit by chatting" ──
  async image_edit_composite(params, helpers) {
    const instruction = asString(params.instruction)?.trim();
    if (!instruction) {
      return { ok: false, message: "image_edit_composite needs an instruction." };
    }
    const { engine, presignUpload, idempotencyKey, runJob } = helpers;
    const blob = await engine.exportComposite();
    const image = await presignUpload(blob);
    const inputs = { image, instruction };
    const key = await idempotencyKey({ capability: "image_edit", inputs });
    const req: CreateJobRequest<"image_edit"> = {
      capability: "image_edit",
      inputs,
      qualityTier: "quality",
      idempotencyKey: key,
    };
    await runJob(req, {
      onArtifact: async (resultBlob, art) => {
        const name = art.placement?.suggestedLayerName ?? "AI edit";
        const id = await engine.loadImageLayer(resultBlob, name);
        // The composite edit covers the whole canvas; place at the origin (or at
        // the artifact's ROI if the backend supplied one).
        const place = art.placement?.roi ?? { x: 0, y: 0 };
        engine.setLayerPosition(id, place.x, place.y);
      },
    });
    return { ok: true, message: `Edited the image: "${instruction}".` };
  },

  // ── 5. generate_layer (AI JOB) — text-to-image ──
  async generate_layer(params, helpers) {
    const prompt = asString(params.prompt)?.trim();
    if (!prompt) return { ok: false, message: "generate_layer needs a prompt." };
    const { engine, idempotencyKey, runJob } = helpers;
    const inputs = { prompt };
    const key = await idempotencyKey({ capability: "text_to_image", inputs });
    const req: CreateJobRequest<"text_to_image"> = {
      capability: "text_to_image",
      inputs,
      qualityTier: "quality",
      idempotencyKey: key,
    };
    await runJob(req, {
      onArtifact: async (resultBlob, art) => {
        const name =
          art.placement?.suggestedLayerName ?? (prompt.slice(0, 40).trim() || "AI image");
        await engine.loadImageLayer(resultBlob, name);
      },
    });
    return { ok: true, message: `Generated a new layer: "${prompt}".` };
  },

  // ── 6. remove_background (AI JOB / client RMBG) ──
  async remove_background(_params, helpers) {
    const { engine, presignUpload, idempotencyKey, runJob } = helpers;
    const id = engine.getActiveLayerId();
    if (!id) return { ok: false, message: "No active layer to cut out." };
    const geo = engine.getLayerGeometry(id);
    if (!geo) return { ok: false, message: "Active layer has no geometry." };

    // Export the active layer's full-resolution pixels. For raster layers we use
    // its own footprint; for others we already fell back to doc bounds in
    // getLayerGeometry. exportLayerRegionPNG only renders raster layers, so guard.
    const rasterId = engine.getActiveRasterLayerId();
    if (!rasterId) {
      return { ok: false, message: "Background removal needs a raster layer active." };
    }
    const blob = await engine.exportLayerRegionPNG(rasterId, geo);
    const image = await presignUpload(blob);
    const inputs = { image };
    const key = await idempotencyKey({ capability: "remove_background", inputs });
    const req: CreateJobRequest<"remove_background"> = {
      capability: "remove_background",
      inputs,
      // Prefer the in-browser RMBG path; the runner handles the directive.
      preferLocation: "client",
      idempotencyKey: key,
    };
    await runJob(req, {
      // Server fallback: place the returned cutout/mask artifact at the source.
      onArtifact: async (resultBlob, art) => {
        const name = art.placement?.suggestedLayerName ?? "Cutout";
        const newId = await engine.loadImageLayer(resultBlob, name);
        const place = art.placement?.roi ?? geo;
        engine.setLayerPosition(newId, place.x, place.y);
      },
      // Client-preferred path: the panel runs RMBG locally and adds the layer.
      // (Wired by the panel's runJob; the executor just needs the hook present.)
      onClientDirective: async () => {
        // The panel's runJob implements local RMBG on the active raster layer.
        // Nothing to do here — placement happens inside that implementation.
      },
    });
    return { ok: true, message: "Removed the background to a new cutout layer." };
  },

  // ── 7. inpaint_selection (AI JOB) — generative fill / object removal ──
  async inpaint_selection(params, helpers) {
    const { engine, presignUpload, idempotencyKey, runJob } = helpers;
    if (!engine.hasSelection()) {
      return {
        ok: false,
        message: "inpaint_selection needs an active selection — none is set.",
      };
    }
    const activeId = engine.getActiveRasterLayerId();
    if (!activeId) {
      return { ok: false, message: "inpaint_selection needs a raster layer active." };
    }
    const roi = engine.getSelectionMaskBounds();
    if (!roi) return { ok: false, message: "Selection has no bounds to inpaint." };

    const mode = (asString(params.mode) === "remove" ? "remove" : "fill") as
      | "fill"
      | "remove";
    const prompt = asString(params.prompt)?.trim() ?? "";
    if (mode === "fill" && !prompt) {
      return { ok: false, message: 'inpaint_selection "fill" mode needs a prompt.' };
    }

    const [imageBlob, maskBlob] = await Promise.all([
      engine.exportLayerRegionPNG(activeId, roi),
      engine.exportSelectionMaskPNG(roi),
    ]);
    const [image, mask] = await Promise.all([
      presignUpload(imageBlob),
      presignUpload(maskBlob),
    ]);

    const inputs: InpaintInputs = { image, mask, prompt, mode, roi: roi as Rect };
    const key = await idempotencyKey({ capability: "inpaint", inputs });
    const req: CreateJobRequest<"inpaint"> = {
      capability: "inpaint",
      inputs,
      qualityTier: "quality",
      idempotencyKey: key,
    };
    await runJob(req, {
      onArtifact: async (resultBlob, art) => {
        const name =
          art.placement?.suggestedLayerName ??
          (mode === "remove" ? "Removed" : "Generative fill");
        const newId = await engine.loadImageLayer(resultBlob, name);
        const place = art.placement?.roi ?? roi;
        engine.setLayerPosition(newId, place.x, place.y);
      },
    });
    return {
      ok: true,
      message:
        mode === "remove"
          ? "Erased the selected region."
          : `Filled the selection: "${prompt}".`,
    };
  },

  // ── 8. fill (SYNC) ──
  async fill(params, { engine }) {
    const color = parseHexColor(params.color);
    if (!color) return { ok: false, message: `Invalid fill color: ${JSON.stringify(params.color)}.` };
    engine.fillSelection(color);
    return { ok: true, message: `Filled with ${asString(params.color)}.` };
  },

  // ── 9. select_all (SYNC) ──
  async select_all(_params, { engine }) {
    engine.selectAll();
    return { ok: true, message: "Selected the whole canvas." };
  },

  // ── 10. deselect (SYNC) ──
  async deselect(_params, { engine }) {
    engine.clearSelection();
    return { ok: true, message: "Cleared the selection." };
  },

  // ── 11. invert_selection (SYNC) ──
  async invert_selection(_params, { engine }) {
    engine.invertSelection();
    return { ok: true, message: "Inverted the selection." };
  },

  // ── 12. set_foreground (SYNC) ──
  async set_foreground(params, { engine }) {
    const color = parseHexColor(params.color);
    if (!color)
      return { ok: false, message: `Invalid foreground color: ${JSON.stringify(params.color)}.` };
    engine.setForeground(color);
    return { ok: true, message: `Set foreground to ${asString(params.color)}.` };
  },
};

/** True for the ops that enqueue an async AI job (vs. a local engine edit). */
export const JOB_OPS = new Set<string>([
  "image_edit_composite",
  "generate_layer",
  "remove_background",
  "inpaint_selection",
]);

/** Every op name the executor implements (should equal AGENT_OP_NAMES). */
export const SUPPORTED_OPS: readonly string[] = Object.keys(OP_HANDLERS);

// ──────────────────────────────────────────────────────────────
// Public API
// ──────────────────────────────────────────────────────────────

/**
 * Execute ONE step. Resolves with a StepResult; never throws — any error from a
 * handler (including an AI-job failure surfaced by runJob) is caught and
 * returned as ok:false so executePlan can keep going.
 */
export async function executeStep(
  step: AgentStep,
  helpers: ExecutorHelpers,
): Promise<StepResult> {
  const op = step.op;
  const isJob = JOB_OPS.has(op);
  const handler = OP_HANDLERS[op];

  // Unknown op. The backend already drops unknown ops, but guard anyway: a newer
  // planner / older web bundle could emit something we don't implement yet.
  if (!handler) {
    const known = (AGENT_OP_NAMES as readonly string[]).includes(op);
    return {
      op,
      ok: false,
      isJob,
      message: known
        ? `Op "${op}" is not implemented by this client yet — skipped.`
        : `Unknown op "${op}" — skipped.`,
    };
  }

  try {
    const params = step.params ?? {};
    const { ok, message } = await handler(params, helpers);
    return { op, ok, isJob, message };
  } catch (e) {
    return {
      op,
      ok: false,
      isJob,
      message: e instanceof Error ? e.message : String(e),
    };
  }
}

/**
 * Execute a whole plan SEQUENTIALLY. Each step is awaited before the next
 * begins (so AI-job results feed into later steps). A failing step is reported
 * but does not abort the run (see ERROR POLICY in the file header).
 *
 * `onProgress` fires twice per step ("start" then "settle") so the panel can
 * render a live checklist.
 */
export async function executePlan(
  plan: AgentPlan,
  helpers: ExecutorHelpers,
  onProgress?: OnProgress,
): Promise<PlanResult> {
  const steps = plan.steps ?? [];
  const results: StepResult[] = [];

  for (let index = 0; index < steps.length; index++) {
    const step = steps[index]!;
    onProgress?.({ index, total: steps.length, step, phase: "start" });
    const result = await executeStep(step, helpers);
    results.push(result);
    onProgress?.({ index, total: steps.length, step, phase: "settle", result });
  }

  const succeeded = results.filter((r) => r.ok).length;
  const failed = results.length - succeeded;
  return { results, ok: failed === 0, succeeded, failed };
}
