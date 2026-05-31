/**
 * Tool + brush parameter store.
 *
 * A tiny imperative store with useSyncExternalStore bindings, mirroring the
 * engine-snapshot pattern. The engine reads tool state synchronously (via the
 * exported `toolStore` getter) when routing pointer events; React reads it
 * reactively for the tool rail and options bar. React never touches pixels.
 */
import { useSyncExternalStore } from "react";

export type ToolId =
  | "move"
  | "brush"
  | "eraser"
  | "marquee-rect"
  | "marquee-ellipse"
  | "lasso"
  | "magic-wand"
  | "hand"
  | "eyedropper"
  | "bucket"
  | "gradient"
  | "pen"
  | "transform"
  | "crop"
  | "text"
  | "shape"
  // ── retouch brushes (stroke-based, read the layer pixels) ──
  | "clone"
  | "heal"
  | "dodge"
  | "burn"
  | "smudge"
  | "blur-brush"
  | "sharpen-brush";

/** Tonal range a dodge/burn stroke targets. */
export type DodgeBurnRange = "shadows" | "midtones" | "highlights";

/** Shape primitive drawn by the shape tool. */
export type ShapeKind = "rect" | "ellipse" | "line";

/** Boolean op applied when a new selection is committed (driven by modifiers). */
export type SelectionOp = "replace" | "add" | "subtract" | "intersect";

/**
 * An RGBA color in straight (non-premultiplied) sRGB space, components 0..1.
 * This is the authoritative color representation used by the UI swatches; the
 * engine converts to linear light when it paints/fills.
 */
export interface RGBAColor {
  r: number;
  g: number;
  b: number;
  a: number;
}

export interface BrushParams {
  /** Diameter in document px. */
  size: number;
  /** Master stroke opacity 0..1. */
  opacity: number;
  /** Edge softness 0..1 (1 = hard). */
  hardness: number;
  /** Per-dab build-up 0..1. */
  flow: number;
}

/**
 * Magic-wand / select-by-color params.
 *   tolerance: 0..255 color distance from the seed considered "in".
 *   contiguous: flood-fill from the seed (true) vs global color match (false).
 *   sampleAllLayers: sample the flattened composite (true) vs the active layer.
 */
export interface MagicWandParams {
  tolerance: number;
  contiguous: boolean;
  sampleAllLayers: boolean;
}

/**
 * Clone-stamp / healing-brush params. Size/hardness/opacity mirror the brush;
 * `aligned` keeps the source offset fixed relative to the first stroke point
 * (true) vs re-anchoring to the original source on each new stroke (false).
 */
export interface CloneParams {
  size: number;
  hardness: number;
  opacity: number;
  aligned: boolean;
}

/** Dodge / burn params (lighten or darken weighted by tonal range). */
export interface DodgeBurnParams {
  size: number;
  hardness: number;
  /** Per-dab strength 0..1. */
  exposure: number;
  range: DodgeBurnRange;
}

/** Smudge params: drag-smear pickup strength. */
export interface SmudgeParams {
  size: number;
  hardness: number;
  /** How much color carries along the path 0..1. */
  strength: number;
}

/** Blur / sharpen brush params. */
export interface FocusParams {
  size: number;
  hardness: number;
  /** Effect amount 0..1. */
  strength: number;
}

/**
 * Type-tool params. `color` is optional: when null the engine uses the current
 * foreground color, so the swatch and the type tool stay in sync by default; a
 * non-null value pins an explicit per-tool color.
 */
export interface TextParams {
  fontFamily: string;
  /** Font size in document px. */
  fontSize: number;
  /** Explicit color, or null to follow the foreground swatch. */
  color: RGBAColor | null;
  align: "left" | "center" | "right";
  bold: boolean;
  italic: boolean;
  /** Line spacing as a multiple of fontSize. */
  lineHeight: number;
}

/**
 * Shape-tool params. `fill` is optional: null means "use foreground". `stroke`
 * width <= 0 means no stroke.
 */
export interface ShapeParams {
  kind: ShapeKind;
  /** Fill color, or null to follow the foreground swatch. */
  fill: RGBAColor | null;
  stroke: { color: RGBAColor; width: number };
}

/** A single gradient stop: position 0..1 along the ramp + a straight-sRGB color. */
export interface GradientStopUI {
  pos: number;
  color: RGBAColor;
}

/**
 * Gradient-tool params. The gradient tool drag uses these `stops` (the engine's
 * applyGradientFill takes the same stop list). `reverse` flips the ramp on
 * apply. Defaults are a two-stop foreground -> background ramp.
 */
export interface GradientParams {
  type: "linear" | "radial";
  /** Ordered stops (pos 0..1). At least two are kept by the store. */
  stops: GradientStopUI[];
  /** Reverse the ramp direction on apply. */
  reverse: boolean;
}

export interface ToolState {
  active: ToolId;
  brush: BrushParams;
  /** Selection feather radius in px applied on commit. */
  feather: number;
  /** Foreground color (brush/bucket/gradient "from"). sRGB straight, 0..1. */
  foreground: RGBAColor;
  /** Background color (gradient "to" / canvas fills). sRGB straight, 0..1. */
  background: RGBAColor;
  /** Type-tool defaults for new text layers. */
  text: TextParams;
  /** Shape-tool params (incl. active shapeKind). */
  shape: ShapeParams;
  /** Gradient-tool params (type + multi-stop ramp + reverse). */
  gradient: GradientParams;
  /** Magic-wand / select-by-color params. */
  magicWand: MagicWandParams;
  /** Clone-stamp + healing-brush params (shared). */
  clone: CloneParams;
  /** Dodge/burn params (shared; `range` distinguishes intent). */
  dodgeBurn: DodgeBurnParams;
  /** Smudge params. */
  smudge: SmudgeParams;
  /** Blur/sharpen brush params (shared). */
  focus: FocusParams;
}

const DEFAULT: ToolState = {
  active: "brush",
  brush: { size: 48, opacity: 1, hardness: 0.8, flow: 1 },
  feather: 0,
  foreground: { r: 0, g: 0, b: 0, a: 1 },
  background: { r: 1, g: 1, b: 1, a: 1 },
  text: {
    fontFamily: "Inter, system-ui, sans-serif",
    fontSize: 64,
    color: null, // follow foreground
    align: "left",
    bold: false,
    italic: false,
    lineHeight: 1.2,
  },
  shape: {
    kind: "rect",
    fill: null, // follow foreground
    stroke: { color: { r: 0, g: 0, b: 0, a: 1 }, width: 0 },
  },
  gradient: {
    type: "linear",
    // Default two-stop foreground -> background ramp (black -> white).
    stops: [
      { pos: 0, color: { r: 0, g: 0, b: 0, a: 1 } },
      { pos: 1, color: { r: 1, g: 1, b: 1, a: 1 } },
    ],
    reverse: false,
  },
  magicWand: { tolerance: 32, contiguous: true, sampleAllLayers: false },
  clone: { size: 48, hardness: 0.6, opacity: 1, aligned: true },
  dodgeBurn: { size: 64, hardness: 0.4, exposure: 0.25, range: "midtones" },
  smudge: { size: 48, hardness: 0.5, strength: 0.5 },
  focus: { size: 48, hardness: 0.5, strength: 0.5 },
};

type Listener = () => void;

class ToolStore {
  private state: ToolState = DEFAULT;
  private listeners = new Set<Listener>();

  get(): ToolState {
    return this.state;
  }

  subscribe(cb: Listener): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  private set(next: ToolState): void {
    this.state = next;
    for (const cb of this.listeners) cb();
  }

  setActive(active: ToolId): void {
    if (this.state.active === active) return;
    this.set({ ...this.state, active });
  }

  setBrush(patch: Partial<BrushParams>): void {
    this.set({ ...this.state, brush: { ...this.state.brush, ...patch } });
  }

  setFeather(feather: number): void {
    this.set({ ...this.state, feather: Math.max(0, feather) });
  }

  // ── type tool ──────────────────────────────────────────
  setText(patch: Partial<TextParams>): void {
    this.set({ ...this.state, text: { ...this.state.text, ...patch } });
  }

  // ── shape tool ─────────────────────────────────────────
  setShape(patch: Partial<ShapeParams>): void {
    this.set({ ...this.state, shape: { ...this.state.shape, ...patch } });
  }
  /** Set the active shape primitive (rect/ellipse/line). */
  setShapeKind(kind: ShapeKind): void {
    if (this.state.shape.kind === kind) return;
    this.set({ ...this.state, shape: { ...this.state.shape, kind } });
  }

  // ── gradient tool ──────────────────────────────────────
  /** Patch gradient params (type / reverse / stops). Stops are normalized. */
  setGradient(patch: Partial<GradientParams>): void {
    const next = { ...this.state.gradient, ...patch };
    if (patch.stops) next.stops = normalizeGradientStops(patch.stops);
    this.set({ ...this.state, gradient: next });
  }
  /** Replace the gradient stop list (clamped + sorted; min two stops kept). */
  setGradientStops(stops: GradientStopUI[]): void {
    this.set({
      ...this.state,
      gradient: { ...this.state.gradient, stops: normalizeGradientStops(stops) },
    });
  }

  // ── magic wand + retouch tools ─────────────────────────
  setMagicWand(patch: Partial<MagicWandParams>): void {
    this.set({ ...this.state, magicWand: { ...this.state.magicWand, ...patch } });
  }
  setClone(patch: Partial<CloneParams>): void {
    this.set({ ...this.state, clone: { ...this.state.clone, ...patch } });
  }
  setDodgeBurn(patch: Partial<DodgeBurnParams>): void {
    this.set({ ...this.state, dodgeBurn: { ...this.state.dodgeBurn, ...patch } });
  }
  setSmudge(patch: Partial<SmudgeParams>): void {
    this.set({ ...this.state, smudge: { ...this.state.smudge, ...patch } });
  }
  setFocus(patch: Partial<FocusParams>): void {
    this.set({ ...this.state, focus: { ...this.state.focus, ...patch } });
  }

  // ── color ──────────────────────────────────────────────
  setForeground(color: RGBAColor): void {
    this.set({ ...this.state, foreground: clampColor(color) });
  }

  setBackground(color: RGBAColor): void {
    this.set({ ...this.state, background: clampColor(color) });
  }

  /** Swap foreground <-> background (Photoshop X). */
  swapColors(): void {
    this.set({
      ...this.state,
      foreground: this.state.background,
      background: this.state.foreground,
    });
  }

  /** Reset to default black foreground / white background (Photoshop D). */
  resetColors(): void {
    this.set({
      ...this.state,
      foreground: { r: 0, g: 0, b: 0, a: 1 },
      background: { r: 1, g: 1, b: 1, a: 1 },
    });
  }
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}
function clampColor(c: RGBAColor): RGBAColor {
  return { r: clamp01(c.r), g: clamp01(c.g), b: clamp01(c.b), a: clamp01(c.a) };
}

/**
 * Normalize a gradient stop list: clamp positions/colors, sort by position, and
 * guarantee at least two stops (a black/white ramp if the caller passes fewer).
 */
function normalizeGradientStops(stops: GradientStopUI[]): GradientStopUI[] {
  const cleaned = stops.map((s) => ({ pos: clamp01(s.pos), color: clampColor(s.color) }));
  cleaned.sort((a, b) => a.pos - b.pos);
  if (cleaned.length === 0) {
    return [
      { pos: 0, color: { r: 0, g: 0, b: 0, a: 1 } },
      { pos: 1, color: { r: 1, g: 1, b: 1, a: 1 } },
    ];
  }
  if (cleaned.length === 1) {
    return [{ pos: 0, color: cleaned[0]!.color }, { pos: 1, color: cleaned[0]!.color }];
  }
  return cleaned;
}

export const toolStore = new ToolStore();

export function useToolState(): ToolState {
  return useSyncExternalStore(
    (cb) => toolStore.subscribe(cb),
    () => toolStore.get(),
    () => toolStore.get(),
  );
}

/**
 * Retouch brushes operate stroke-by-stroke on the active layer's existing
 * pixels (clone/heal/dodge/burn/smudge/blur/sharpen). They route through the
 * same paint gesture as brush/eraser but use a per-mode stroke-apply pass.
 */
export function isRetouchTool(t: ToolId): boolean {
  return (
    t === "clone" ||
    t === "heal" ||
    t === "dodge" ||
    t === "burn" ||
    t === "smudge" ||
    t === "blur-brush" ||
    t === "sharpen-brush"
  );
}

/**
 * True for tools that paint into a layer / mask (brush family). Includes the
 * retouch brushes so pointerdown routes them through the paint gesture.
 */
export function isPaintTool(t: ToolId): boolean {
  return t === "brush" || t === "eraser" || isRetouchTool(t);
}

/** True for the marquee/lasso selection tools. */
export function isSelectionTool(t: ToolId): boolean {
  return t === "marquee-rect" || t === "marquee-ellipse" || t === "lasso";
}

/** Resolve the boolean op from keyboard modifiers on a pointerdown. */
export function selectionOpFromEvent(e: PointerEvent | MouseEvent): SelectionOp {
  if (e.shiftKey && e.altKey) return "intersect";
  if (e.shiftKey) return "add";
  if (e.altKey) return "subtract";
  return "replace";
}

// ════════════════════════════════════════════════════════════
//  SWATCHES STORE
// ════════════════════════════════════════════════════════════
/**
 * A list of saved color swatches (straight sRGB 0..1). The Swatches panel reads
 * this reactively (useSwatches) and adds/removes via the exported `swatchStore`.
 * Mirrors the toolStore pattern (imperative store + useSyncExternalStore).
 */
const DEFAULT_SWATCHES: RGBAColor[] = [
  { r: 0, g: 0, b: 0, a: 1 }, // black
  { r: 1, g: 1, b: 1, a: 1 }, // white
  { r: 0.9, g: 0.16, b: 0.22, a: 1 }, // red
  { r: 0.97, g: 0.62, b: 0.04, a: 1 }, // orange
  { r: 0.98, g: 0.85, b: 0.18, a: 1 }, // yellow
  { r: 0.2, g: 0.74, b: 0.36, a: 1 }, // green
  { r: 0.16, g: 0.5, b: 0.9, a: 1 }, // blue
  { r: 0.55, g: 0.27, b: 0.86, a: 1 }, // purple
];

class SwatchStore {
  private swatches: RGBAColor[] = DEFAULT_SWATCHES.map((c) => ({ ...c }));
  private listeners = new Set<Listener>();

  get(): readonly RGBAColor[] {
    return this.swatches;
  }
  subscribe(cb: Listener): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }
  private set(next: RGBAColor[]): void {
    this.swatches = next;
    for (const cb of this.listeners) cb();
  }

  /** Append a swatch (de-duplicating an identical existing color). */
  add(color: RGBAColor): void {
    const c = clampColor(color);
    if (this.swatches.some((s) => colorsEqual(s, c))) return;
    this.set([...this.swatches, c]);
  }
  /** Remove the swatch at `index` (no-op if out of range). */
  removeAt(index: number): void {
    if (index < 0 || index >= this.swatches.length) return;
    this.set(this.swatches.filter((_, i) => i !== index));
  }
  /** Reset to the built-in defaults. */
  reset(): void {
    this.set(DEFAULT_SWATCHES.map((c) => ({ ...c })));
  }
}

function colorsEqual(a: RGBAColor, b: RGBAColor): boolean {
  const eq = (x: number, y: number) => Math.abs(x - y) < 1 / 512;
  return eq(a.r, b.r) && eq(a.g, b.g) && eq(a.b, b.b) && eq(a.a, b.a);
}

export const swatchStore = new SwatchStore();

/** Reactive saved-swatch list for a Swatches panel. */
export function useSwatches(): readonly RGBAColor[] {
  return useSyncExternalStore(
    (cb) => swatchStore.subscribe(cb),
    () => swatchStore.get(),
    () => swatchStore.get(),
  );
}
