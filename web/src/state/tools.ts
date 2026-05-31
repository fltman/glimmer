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
  // ── AI client-ML selection: click-to-select-anything (SAM) ──
  | "sam-select"
  | "hand"
  | "eyedropper"
  | "bucket"
  | "gradient"
  | "pen"
  | "transform"
  | "crop"
  | "text"
  | "shape"
  | "pattern-stamp"
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
  // ── shape dynamics (all optional; omitting keeps the soft-round default) ──
  /** Tip roundness 0..1 (1 = circular; lower squashes the minor axis -> ellipse). */
  roundness?: number;
  /** Tip rotation in degrees (orients the elliptical/textured tip). */
  angle?: number;
  /** Dab spacing as a percent of the diameter (default 10). */
  spacing?: number;
  /** Random per-dab position jitter 0..1 (fraction of the radius). */
  scatter?: number;
  /** Random per-dab size jitter 0..1 (fraction of the diameter). */
  sizeJitter?: number;
  /** Map pen pressure to dab size when true. */
  pressureSize?: boolean;
  /** Map pen pressure to dab opacity/flow when true. */
  pressureOpacity?: boolean;
  /** Procedural noise-modulated tip alpha (chalk/textured) when true. */
  textured?: boolean;
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
  brush: {
    size: 48,
    opacity: 1,
    hardness: 0.8,
    flow: 1,
    roundness: 1,
    angle: 0,
    spacing: 10,
    scatter: 0,
    sizeJitter: 0,
    pressureSize: false,
    pressureOpacity: false,
    textured: false,
  },
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
 * retouch brushes so pointerdown routes them through the paint gesture. The
 * pattern-stamp is NOT included here: it paints with the brush dab into a wet
 * coverage buffer but flattens the PATTERN (not the foreground color), so the
 * engine routes it through its own gesture branch (see isPatternStampTool).
 */
export function isPaintTool(t: ToolId): boolean {
  return t === "brush" || t === "eraser" || isRetouchTool(t);
}

/** True for the pattern-stamp tool (brush-driven pattern dabs). */
export function isPatternStampTool(t: ToolId): boolean {
  return t === "pattern-stamp";
}

/** True for the marquee/lasso selection tools. */
export function isSelectionTool(t: ToolId): boolean {
  return t === "marquee-rect" || t === "marquee-ellipse" || t === "lasso";
}

/**
 * True for the SAM "select anything" tool. The UI should render a CROSSHAIR
 * cursor for it (the UI agent must add the entry to CanvasHost's CURSORS map).
 */
export function isSamSelectTool(t: ToolId): boolean {
  return t === "sam-select";
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

// ════════════════════════════════════════════════════════════
//  BRUSH PRESETS
// ════════════════════════════════════════════════════════════
/**
 * A saved brush configuration. `params` is the brush-param subset applied to
 * toolStore.brush by applyPreset. Built-ins can't be removed; user presets are
 * captured from the live brush via addPreset.
 */
export interface BrushPreset {
  id: string;
  name: string;
  params: BrushParams;
  builtin?: boolean;
}

/** Fill in every BrushParams field so a preset fully defines the brush. */
function fullBrushParams(p: Partial<BrushParams>): BrushParams {
  return {
    size: p.size ?? 48,
    opacity: p.opacity ?? 1,
    hardness: p.hardness ?? 0.8,
    flow: p.flow ?? 1,
    roundness: p.roundness ?? 1,
    angle: p.angle ?? 0,
    spacing: p.spacing ?? 10,
    scatter: p.scatter ?? 0,
    sizeJitter: p.sizeJitter ?? 0,
    pressureSize: p.pressureSize ?? false,
    pressureOpacity: p.pressureOpacity ?? false,
    textured: p.textured ?? false,
  };
}

/** The built-in preset set (cloned on read so callers can't mutate them). */
const BUILTIN_BRUSH_PRESETS: BrushPreset[] = [
  {
    id: "soft-round",
    name: "Soft Round",
    builtin: true,
    params: fullBrushParams({ size: 48, hardness: 0.5, flow: 1, opacity: 1 }),
  },
  {
    id: "hard-round",
    name: "Hard Round",
    builtin: true,
    params: fullBrushParams({ size: 24, hardness: 0.95, flow: 1, opacity: 1 }),
  },
  {
    id: "chalk",
    name: "Chalk / Textured",
    builtin: true,
    params: fullBrushParams({
      size: 64,
      hardness: 0.7,
      flow: 0.85,
      opacity: 1,
      spacing: 8,
      scatter: 0.12,
      sizeJitter: 0.2,
      textured: true,
    }),
  },
  {
    id: "calligraphic",
    name: "Calligraphic",
    builtin: true,
    params: fullBrushParams({
      size: 40,
      hardness: 0.9,
      flow: 1,
      opacity: 1,
      roundness: 0.2,
      angle: 45,
      spacing: 6,
    }),
  },
  {
    id: "airbrush",
    name: "Airbrush",
    builtin: true,
    params: fullBrushParams({
      size: 80,
      hardness: 0.2,
      flow: 0.1,
      opacity: 1,
      spacing: 5,
      pressureOpacity: true,
    }),
  },
  {
    id: "pencil",
    name: "Pencil",
    builtin: true,
    params: fullBrushParams({
      size: 6,
      hardness: 1,
      flow: 1,
      opacity: 1,
      spacing: 5,
    }),
  },
];

class BrushPresetStore {
  private presets: BrushPreset[] = BUILTIN_BRUSH_PRESETS.map(clonePreset);
  private seq = 0;
  private listeners = new Set<Listener>();

  get(): readonly BrushPreset[] {
    return this.presets;
  }
  subscribe(cb: Listener): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }
  private set(next: BrushPreset[]): void {
    this.presets = next;
    for (const cb of this.listeners) cb();
  }

  /** Apply a preset's params to the live brush (no-op if the id is unknown). */
  apply(id: string): void {
    const p = this.presets.find((x) => x.id === id);
    if (!p) return;
    toolStore.setBrush({ ...p.params });
  }

  /** Save the current live brush params as a new user preset. Returns its id. */
  add(name: string): string {
    this.seq += 1;
    const id = `brush_${this.seq}`;
    const preset: BrushPreset = {
      id,
      name: name.trim() || `Brush ${this.seq}`,
      params: fullBrushParams(toolStore.get().brush),
    };
    this.set([...this.presets, preset]);
    return id;
  }

  /** Remove a user preset (built-ins are protected). */
  remove(id: string): void {
    const p = this.presets.find((x) => x.id === id);
    if (!p || p.builtin) return;
    this.set(this.presets.filter((x) => x.id !== id));
  }
}

function clonePreset(p: BrushPreset): BrushPreset {
  return { ...p, params: { ...p.params } };
}

export const brushPresetStore = new BrushPresetStore();

/** Reactive brush-preset list (for a presets panel / dropdown). */
export function useBrushPresets(): readonly BrushPreset[] {
  return useSyncExternalStore(
    (cb) => brushPresetStore.subscribe(cb),
    () => brushPresetStore.get(),
    () => brushPresetStore.get(),
  );
}

/** Reactive live brush params (for the brush options bar / dynamics panel). */
export function useBrushParams(): BrushParams {
  return useSyncExternalStore(
    (cb) => toolStore.subscribe(cb),
    () => toolStore.get().brush,
    () => toolStore.get().brush,
  );
}

// ════════════════════════════════════════════════════════════
//  PATTERNS (procedural fill / stamp tiles)
// ════════════════════════════════════════════════════════════
/**
 * A pattern is a small SEAMLESSLY-TILING tile drawn procedurally onto a 2D
 * canvas. The engine rasterizes a tile to ImageData (via renderPatternTile) and
 * uploads it as a texture, then tiles it across the fill region in-shader using
 * the pattern's `scale`. Built-ins draw a foreground/background-agnostic tile in
 * straight sRGB; the engine treats the tile as sRGB on upload.
 *
 * A future "define from selection" user pattern would add entries whose tile
 * ImageData is captured from the canvas — noted as a followup since it needs an
 * extra readback + storage path.
 */
export interface PatternDef {
  id: string;
  name: string;
  /** Tile edge length in px (the tile is square and tiles seamlessly). */
  tileSize: number;
  /** Draw one seamless tile filling [0,size]x[0,size] on a 2D context. */
  draw: (ctx: CanvasRenderingContext2D, size: number) => void;
}

/** Built-in procedural patterns. Each tile is designed to wrap seamlessly. */
export const BUILTIN_PATTERNS: PatternDef[] = [
  {
    id: "checkerboard",
    name: "Checkerboard",
    tileSize: 32,
    draw: (ctx, s) => {
      ctx.fillStyle = "#ffffff";
      ctx.fillRect(0, 0, s, s);
      ctx.fillStyle = "#000000";
      const h = s / 2;
      ctx.fillRect(0, 0, h, h);
      ctx.fillRect(h, h, h, h);
    },
  },
  {
    id: "dots",
    name: "Dots",
    tileSize: 32,
    draw: (ctx, s) => {
      ctx.fillStyle = "#ffffff";
      ctx.fillRect(0, 0, s, s);
      ctx.fillStyle = "#222222";
      const r = s * 0.16;
      // Center dot + corner quarters so the tile wraps seamlessly.
      const pts: [number, number][] = [
        [s / 2, s / 2],
        [0, 0],
        [s, 0],
        [0, s],
        [s, s],
      ];
      for (const [cx, cy] of pts) {
        ctx.beginPath();
        ctx.arc(cx, cy, r, 0, Math.PI * 2);
        ctx.fill();
      }
    },
  },
  {
    id: "diagonal-stripes",
    name: "Diagonal Stripes",
    tileSize: 32,
    draw: (ctx, s) => {
      ctx.fillStyle = "#ffffff";
      ctx.fillRect(0, 0, s, s);
      ctx.strokeStyle = "#222222";
      ctx.lineWidth = s * 0.18;
      // Three offset diagonals so the stripe wraps across the tile edge.
      ctx.beginPath();
      for (let o = -s; o <= s; o += s) {
        ctx.moveTo(o, s);
        ctx.lineTo(o + s, 0);
      }
      ctx.stroke();
    },
  },
  {
    id: "grid",
    name: "Grid",
    tileSize: 32,
    draw: (ctx, s) => {
      ctx.fillStyle = "#ffffff";
      ctx.fillRect(0, 0, s, s);
      ctx.strokeStyle = "#444444";
      const w = Math.max(1, s * 0.06);
      ctx.lineWidth = w;
      // Draw the top + left edges; tiling completes the grid.
      ctx.strokeRect(w / 2, w / 2, s - w, s - w);
    },
  },
  {
    id: "noise",
    name: "Noise",
    tileSize: 64,
    draw: (ctx, s) => {
      const img = ctx.createImageData(s, s);
      const d = img.data;
      // Deterministic value noise (stable seed) so the tile is reproducible.
      let seed = 0x9e3779b9 >>> 0;
      const rng = () => {
        seed = (seed * 1664525 + 1013904223) >>> 0;
        return seed / 0xffffffff;
      };
      for (let i = 0; i < s * s; i++) {
        const v = Math.round(rng() * 255);
        d[i * 4] = v;
        d[i * 4 + 1] = v;
        d[i * 4 + 2] = v;
        d[i * 4 + 3] = 255;
      }
      ctx.putImageData(img, 0, 0);
    },
  },
];

/**
 * Rasterize a pattern's tile to ImageData (straight sRGB, opaque/with alpha as
 * drawn). The engine calls this to obtain the tile pixels to upload. Returns
 * null if a 2D context can't be created (defensive; never in practice).
 */
export function renderPatternTile(def: PatternDef): ImageData | null {
  const size = Math.max(2, Math.round(def.tileSize));
  const cv = document.createElement("canvas");
  cv.width = size;
  cv.height = size;
  const ctx = cv.getContext("2d");
  if (!ctx) return null;
  ctx.clearRect(0, 0, size, size);
  def.draw(ctx, size);
  return ctx.getImageData(0, 0, size, size);
}

export interface PatternState {
  /** Currently-selected pattern id (one of BUILTIN_PATTERNS, or user). */
  selectedId: string;
  /** Tile scale multiplier (1 = native tile size). */
  scale: number;
  /** Fill/stamp opacity 0..1. */
  opacity: number;
}

class PatternStore {
  private patterns: PatternDef[] = BUILTIN_PATTERNS.slice();
  private state: PatternState = {
    selectedId: BUILTIN_PATTERNS[0]!.id,
    scale: 1,
    opacity: 1,
  };
  private listeners = new Set<Listener>();

  /** All available pattern definitions (built-ins + any future user tiles). */
  getPatterns(): readonly PatternDef[] {
    return this.patterns;
  }
  /** The selected-pattern / scale / opacity state. */
  getState(): PatternState {
    return this.state;
  }
  /** Look up a pattern by id (defaults to the first built-in if unknown). */
  getById(id: string): PatternDef {
    return this.patterns.find((p) => p.id === id) ?? this.patterns[0]!;
  }
  /** The currently-selected pattern def. */
  getSelected(): PatternDef {
    return this.getById(this.state.selectedId);
  }

  subscribe(cb: Listener): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }
  private emit(): void {
    for (const cb of this.listeners) cb();
  }

  setSelected(id: string): void {
    if (this.state.selectedId === id) return;
    this.state = { ...this.state, selectedId: id };
    this.emit();
  }
  setScale(scale: number): void {
    const s = Math.max(0.05, Math.min(16, scale));
    if (this.state.scale === s) return;
    this.state = { ...this.state, scale: s };
    this.emit();
  }
  setOpacity(opacity: number): void {
    const o = clamp01(opacity);
    if (this.state.opacity === o) return;
    this.state = { ...this.state, opacity: o };
    this.emit();
  }
}

export const patternStore = new PatternStore();

/** Reactive pattern list (for a Patterns panel / dropdown). */
export function usePatterns(): readonly PatternDef[] {
  return useSyncExternalStore(
    (cb) => patternStore.subscribe(cb),
    () => patternStore.getPatterns(),
    () => patternStore.getPatterns(),
  );
}

/** Reactive selected-pattern / scale / opacity state (for the options bar). */
export function usePatternState(): PatternState {
  return useSyncExternalStore(
    (cb) => patternStore.subscribe(cb),
    () => patternStore.getState(),
    () => patternStore.getState(),
  );
}
