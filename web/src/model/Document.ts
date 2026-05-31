/**
 * Serializable document / layer model.
 *
 * The GPU is reconstructible from this: each raster layer keeps its CPU source
 * (ImageBitmap or ImageData) so we can rebuild textures after a
 * `webglcontextlost`. The engine resolves a GPU texture handle lazily and
 * caches it keyed by layer id — the model itself never holds GL objects.
 *
 * Phase 1 is single-texture raster layers only; tiling lands in Phase 2.
 */

export type LayerId = string;

/** Full Photoshop-style set. Phase 2 renders all of these. */
export type BlendMode =
  | "normal"
  | "multiply"
  | "screen"
  | "overlay"
  | "darken"
  | "lighten"
  | "color-dodge"
  | "color-burn"
  | "hard-light"
  | "soft-light"
  | "difference"
  | "exclusion"
  | "linear-dodge"
  | "linear-burn"
  | "hue"
  | "saturation"
  | "color"
  | "luminosity";

/**
 * Stable index per blend mode — uploaded to the blend shader as an int uniform.
 * MUST stay in sync with the switch in BLEND_FRAG (shaders.ts).
 */
export const BLEND_MODE_INDEX: Record<BlendMode, number> = {
  normal: 0,
  multiply: 1,
  screen: 2,
  overlay: 3,
  darken: 4,
  lighten: 5,
  "color-dodge": 6,
  "color-burn": 7,
  "hard-light": 8,
  "soft-light": 9,
  difference: 10,
  exclusion: 11,
  "linear-dodge": 12,
  "linear-burn": 13,
  hue: 14,
  saturation: 15,
  color: 16,
  luminosity: 17,
};

/** Human-readable labels for the LayersPanel dropdown, in menu order. */
export const BLEND_MODE_LABELS: { mode: BlendMode; label: string }[] = [
  { mode: "normal", label: "Normal" },
  { mode: "darken", label: "Darken" },
  { mode: "multiply", label: "Multiply" },
  { mode: "color-burn", label: "Color Burn" },
  { mode: "linear-burn", label: "Linear Burn" },
  { mode: "lighten", label: "Lighten" },
  { mode: "screen", label: "Screen" },
  { mode: "color-dodge", label: "Color Dodge" },
  { mode: "linear-dodge", label: "Linear Dodge (Add)" },
  { mode: "overlay", label: "Overlay" },
  { mode: "soft-light", label: "Soft Light" },
  { mode: "hard-light", label: "Hard Light" },
  { mode: "difference", label: "Difference" },
  { mode: "exclusion", label: "Exclusion" },
  { mode: "hue", label: "Hue" },
  { mode: "saturation", label: "Saturation" },
  { mode: "color", label: "Color" },
  { mode: "luminosity", label: "Luminosity" },
];

export type LayerKind = "raster" | "adjustment" | "text" | "group";

/** Horizontal text alignment for a text layer. */
export type TextAlign = "left" | "center" | "right";

/** Re-exported from the adjustment registry (kept loose to avoid a cycle). */
export type AdjustmentType =
  | "brightness_contrast"
  | "levels"
  | "curves"
  | "exposure"
  | "hue_saturation"
  | "vibrance"
  | "color_balance"
  | "black_white"
  | "photo_filter"
  | "channel_mixer"
  | "invert"
  | "posterize"
  | "threshold"
  | "gradient_map";
export type AdjustmentParams = Record<string, unknown>;

// ── layer styles / effects ─────────────────────────────────
/**
 * Non-destructive layer styles (Photoshop "Layer Styles"). All effects are
 * derived from the layer's own alpha at composite time (no pixels are baked).
 * Colors are straight sRGB 0..1. Distances/sizes are in document pixels.
 *
 * Render order (matches Photoshop): BELOW the layer first (drop shadow, outer
 * glow), then the layer pixels, then ON-TOP effects (color overlay, stroke).
 * Inner shadow is drawn on top of the layer but clipped to its alpha.
 */
export interface DropShadowEffect {
  enabled: boolean;
  color: TextColor;
  opacity: number; // 0..1
  /** Light angle in degrees (0 = from the right, CCW positive). */
  angle: number;
  /** Offset distance from the layer, in doc px. */
  distance: number;
  /** Blur size (Gaussian radius) in doc px. */
  size: number;
  /** Choke/spread 0..1 (thickens the alpha before blurring). */
  spread?: number;
}
export interface InnerShadowEffect {
  enabled: boolean;
  color: TextColor;
  opacity: number;
  angle: number;
  distance: number;
  size: number;
}
export interface StrokeEffect {
  enabled: boolean;
  color: TextColor;
  /** Stroke width in doc px. */
  width: number;
  position: "outside" | "inside" | "center";
}
export interface OuterGlowEffect {
  enabled: boolean;
  color: TextColor;
  opacity: number;
  /** Glow size (Gaussian radius) in doc px. */
  size: number;
}
export interface ColorOverlayEffect {
  enabled: boolean;
  color: TextColor;
  opacity: number;
  blendMode: BlendMode;
}

/** The bag of layer styles attached to a layer (all optional). */
export interface LayerEffects {
  dropShadow?: DropShadowEffect;
  innerShadow?: InnerShadowEffect;
  stroke?: StrokeEffect;
  outerGlow?: OuterGlowEffect;
  colorOverlay?: ColorOverlayEffect;
}

/** The distinct kinds of layer effect (for updateLayerEffect dispatch). */
export type LayerEffectType =
  | "dropShadow"
  | "innerShadow"
  | "stroke"
  | "outerGlow"
  | "colorOverlay";

/** True if any effect in the bag is present + enabled. */
export function hasActiveEffects(fx: LayerEffects | undefined): boolean {
  if (!fx) return false;
  return !!(
    fx.dropShadow?.enabled ||
    fx.innerShadow?.enabled ||
    fx.stroke?.enabled ||
    fx.outerGlow?.enabled ||
    fx.colorOverlay?.enabled
  );
}

/** Compact per-layer effects summary for the snapshot (UI style badges). */
export interface LayerEffectsSummary {
  dropShadow: boolean;
  innerShadow: boolean;
  stroke: boolean;
  outerGlow: boolean;
  colorOverlay: boolean;
}
function effectsSummary(fx: LayerEffects | undefined): LayerEffectsSummary | undefined {
  if (!fx) return undefined;
  return {
    dropShadow: !!fx.dropShadow?.enabled,
    innerShadow: !!fx.innerShadow?.enabled,
    stroke: !!fx.stroke?.enabled,
    outerGlow: !!fx.outerGlow?.enabled,
    colorOverlay: !!fx.colorOverlay?.enabled,
  };
}

/**
 * A per-layer single-channel mask (value 0..1, white = visible). CPU-
 * authoritative so it survives GL context loss; the engine resolves an R8
 * texture from it lazily, re-uploading whenever `version` changes. Dimensions
 * match the owning layer's width/height (mask is in layer-local space).
 */
export interface LayerMask {
  /** width*height bytes, row-major, 0..255. 255 = fully visible. */
  data: Uint8Array;
  width: number;
  height: number;
  /** Bumped on every edit so the engine knows to re-upload the texture. */
  version: number;
  /** Mask is shown in the composite (true) or temporarily disabled (false). */
  enabled: boolean;
}

/** A raster layer backed by a CPU bitmap source. */
export interface RasterLayer {
  id: LayerId;
  kind: "raster";
  name: string;
  visible: boolean;
  opacity: number; // 0..1
  blendMode: BlendMode;
  /** CPU-authoritative pixels — survives GL context loss. */
  source: ImageBitmap | ImageData;
  width: number;
  height: number;
  /** Top-left position in document space. */
  x: number;
  y: number;
  /** Optional layer mask; absent until one is added. */
  mask?: LayerMask;
  /** Id of the group this layer belongs to, or null when at the document root. */
  parentId?: LayerId | null;
  /** When true, clipped to the alpha of the layer directly below (same group). */
  clipping?: boolean;
  /** Non-destructive layer styles. */
  effects?: LayerEffects;
}

/**
 * A non-destructive adjustment layer. It carries no pixels of its own; the
 * engine renders it as a fullscreen pass that modifies everything composited
 * BELOW it. `params` is the adjustment-specific bag (see adjustments.ts).
 */
export interface AdjustmentLayer {
  id: LayerId;
  kind: "adjustment";
  name: string;
  visible: boolean;
  opacity: number; // 0..1 (effect strength)
  blendMode: BlendMode;
  adjustmentType: AdjustmentType;
  params: AdjustmentParams;
  /** Optional layer mask scoping where the effect applies. */
  mask?: LayerMask;
  /** When true, the effect is clipped to the single layer directly below. */
  clipping?: boolean;
  /** Id of the group this layer belongs to, or null when at the document root. */
  parentId?: LayerId | null;
}

/**
 * A straight (non-premultiplied) sRGB color, components 0..1. Structurally
 * identical to `RGBAColor` in state/tools.ts; redeclared here so the model layer
 * does not depend on the state layer (keeps the dependency direction one-way).
 */
export interface TextColor {
  r: number;
  g: number;
  b: number;
  a: number;
}

/**
 * A type (text) layer. Its `text` + typographic params are authoritative; the
 * engine rasterizes them to a CPU `source` bitmap (cached by `version`) and to a
 * GPU texture for compositing. `width`/`height`/`source` mirror RasterLayer so
 * the compositor treats a text layer exactly like a positioned raster quad once
 * rasterized. `x`/`y` are the top-left of the rasterized bitmap in doc space.
 */
export interface TextLayer {
  id: LayerId;
  kind: "text";
  name: string;
  visible: boolean;
  opacity: number; // 0..1
  blendMode: BlendMode;
  mask?: LayerMask;
  /** Top-left of the rasterized text bitmap in document space. */
  x: number;
  y: number;
  /** Rasterized bitmap dimensions (filled in on first rasterize). */
  width: number;
  height: number;
  /** Rasterized pixels — set by the engine; undefined until first rasterize. */
  source?: ImageBitmap | ImageData;
  /** Bumped whenever any typographic param changes (engine re-rasterizes). */
  version: number;

  // ── typographic params ──
  text: string;
  fontFamily: string;
  fontSize: number; // px in document space
  color: TextColor; // straight sRGB 0..1
  align: TextAlign;
  bold: boolean;
  italic: boolean;
  /** Multiplier on fontSize for line spacing (e.g. 1.2). */
  lineHeight: number;
  /** Id of the group this layer belongs to, or null when at the document root. */
  parentId?: LayerId | null;
  /** When true, clipped to the alpha of the layer directly below (same group). */
  clipping?: boolean;
  /** Non-destructive layer styles. */
  effects?: LayerEffects;
}

/**
 * A layer GROUP. Holds an ordered list of child layer ids (bottom -> top, same
 * convention as the document root order). The group is composited by rendering
 * its children into an isolated buffer, then blending that buffer into the
 * parent with the group's own opacity / blendMode / mask. `collapsed` only hides
 * the children rows in the UI — collapsed groups still render.
 */
export interface GroupLayer {
  id: LayerId;
  kind: "group";
  name: string;
  visible: boolean;
  opacity: number; // 0..1
  blendMode: BlendMode;
  /** Optional group mask (full-document, like an adjustment mask). */
  mask?: LayerMask;
  /** Child ids, bottom -> top. */
  childrenIds: LayerId[];
  /** UI-only: hide child rows in the LayersPanel. */
  collapsed: boolean;
  /** Id of the parent group, or null when at the document root. */
  parentId?: LayerId | null;
}

export type LayerNode = RasterLayer | AdjustmentLayer | TextLayer | GroupLayer;

/** Layers that carry positioned pixels in the compositor (raster + text). */
export type PixelLayer = RasterLayer | TextLayer;

/** Narrowing helpers. */
export function isRasterLayer(n: LayerNode): n is RasterLayer {
  return n.kind === "raster";
}
export function isAdjustmentLayer(n: LayerNode): n is AdjustmentLayer {
  return n.kind === "adjustment";
}
export function isTextLayer(n: LayerNode): n is TextLayer {
  return n.kind === "text";
}
export function isGroupLayer(n: LayerNode): n is GroupLayer {
  return n.kind === "group";
}
/** True for layers with a positioned bitmap source (raster OR text). */
export function isPixelLayer(n: LayerNode): n is PixelLayer {
  return n.kind === "raster" || n.kind === "text";
}

/** Lightweight snapshot for React (no pixel sources, no GL). */
export interface LayerSnapshot {
  id: LayerId;
  kind: LayerKind;
  name: string;
  visible: boolean;
  opacity: number;
  blendMode: BlendMode;
  width: number;
  height: number;
  /** Whether the layer carries a mask, and if it's enabled. */
  hasMask: boolean;
  maskEnabled: boolean;
  /** Adjustment layers only: the adjustment type + live params. */
  adjustmentType?: AdjustmentType;
  params?: AdjustmentParams;
  /** Clipping mask flag (adjustment + raster + text layers). */
  clipping?: boolean;
  /** Text layers only: the live typographic params (so panels can edit them). */
  text?: TextLayerSnapshot;

  // ── tree structure (groups) ──
  /** Nesting depth: 0 at the document root, +1 per enclosing group. */
  depth: number;
  /** Parent group id, or null at the document root. */
  parentId: LayerId | null;
  /** True for group layers. */
  isGroup: boolean;
  /** Group layers only: whether the group's children rows are collapsed. */
  collapsed?: boolean;
  /** Compact summary of active layer effects (for style badges), if any. */
  effects?: LayerEffectsSummary;
}

/** Serializable copy of a text layer's typographic params (for React). */
export interface TextLayerSnapshot {
  text: string;
  fontFamily: string;
  fontSize: number;
  color: TextColor;
  align: TextAlign;
  bold: boolean;
  italic: boolean;
  lineHeight: number;
}

export interface DocumentSnapshot {
  width: number;
  height: number;
  /** Ordered top -> bottom (index 0 is the top-most layer). */
  layers: LayerSnapshot[];
  activeLayerId: LayerId | null;
}

/** Captured tree structure for undoing structural ops (group/ungroup/move). */
export interface DocStructure {
  /** Document-root child ids, bottom -> top. */
  root: LayerId[];
  /** group id -> its children ids (bottom -> top). */
  groups: Record<LayerId, LayerId[]>;
  /** node id -> its parentId (null = root). */
  parents: Record<LayerId, LayerId | null>;
}

type ChangeListener = () => void;

let idCounter = 0;
function nextId(): LayerId {
  idCounter += 1;
  return `layer_${idCounter}_${Math.random().toString(36).slice(2, 8)}`;
}

const ADJUSTMENT_NAMES: Record<AdjustmentType, string> = {
  brightness_contrast: "Brightness/Contrast",
  levels: "Levels",
  curves: "Curves",
  exposure: "Exposure",
  hue_saturation: "Hue/Saturation",
  vibrance: "Vibrance",
  color_balance: "Color Balance",
  black_white: "Black & White",
  photo_filter: "Photo Filter",
  channel_mixer: "Channel Mixer",
  invert: "Invert",
  posterize: "Posterize",
  threshold: "Threshold",
  gradient_map: "Gradient Map",
};
function defaultAdjustmentName(type: AdjustmentType): string {
  return ADJUSTMENT_NAMES[type] ?? "Adjustment";
}

/** A layer name derived from a text layer's content (first line, trimmed). */
function deriveTextName(text: string): string {
  const firstLine = (text.split("\n")[0] ?? "").trim();
  if (!firstLine) return "Text";
  return firstLine.length > 28 ? firstLine.slice(0, 28) + "…" : firstLine;
}

/** Serializable copy of a text layer's typographic params. */
function textSnapshot(n: TextLayer): TextLayerSnapshot {
  return {
    text: n.text,
    fontFamily: n.fontFamily,
    fontSize: n.fontSize,
    color: { ...n.color },
    align: n.align,
    bold: n.bold,
    italic: n.italic,
    lineHeight: n.lineHeight,
  };
}

/** Patch shape accepted when updating a text layer's typographic params. */
export interface TextLayerPatch {
  text?: string;
  fontFamily?: string;
  fontSize?: number;
  color?: TextColor;
  align?: TextAlign;
  bold?: boolean;
  italic?: boolean;
  lineHeight?: number;
}

export class Document {
  width: number;
  height: number;

  /** Flat map of ALL layers (including those nested inside groups). */
  private nodes = new Map<LayerId, LayerNode>();
  /**
   * Root-level child ids, bottom -> top (matches compositing order). Layers
   * inside a group are NOT in this list — they live in their group's
   * `childrenIds`. Use `orderBottomToTop()` for the root order and
   * `childrenOf(groupId)` for a group's children.
   */
  private order: LayerId[] = [];
  private activeLayerId: LayerId | null = null;
  private listeners = new Set<ChangeListener>();

  constructor(width = 1024, height = 1024) {
    this.width = width;
    this.height = height;
  }

  // ── events ──────────────────────────────────────────────
  onChange(cb: ChangeListener): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }
  private emit(): void {
    for (const cb of this.listeners) cb();
  }

  // ── reads ───────────────────────────────────────────────
  /** ROOT-level layer ids bottom -> top (compositing order at the doc root). */
  orderBottomToTop(): readonly LayerId[] {
    return this.order;
  }
  /** A group's child ids bottom -> top, or [] if `id` is not a group. */
  childrenOf(id: LayerId): readonly LayerId[] {
    const n = this.nodes.get(id);
    return n && n.kind === "group" ? n.childrenIds : [];
  }
  /**
   * The sibling list a layer lives in (its group's childrenIds, or the root
   * order) plus the index within it. Returns null if the layer is unknown.
   */
  private siblingList(id: LayerId): { list: LayerId[]; index: number } | null {
    const n = this.nodes.get(id);
    if (!n) return null;
    const pid = (n as { parentId?: LayerId | null }).parentId ?? null;
    if (pid) {
      const parent = this.nodes.get(pid);
      if (parent && parent.kind === "group") {
        return { list: parent.childrenIds, index: parent.childrenIds.indexOf(id) };
      }
    }
    return { list: this.order, index: this.order.indexOf(id) };
  }
  getLayer(id: LayerId): LayerNode | undefined {
    return this.nodes.get(id);
  }
  getActiveLayerId(): LayerId | null {
    return this.activeLayerId;
  }
  /** True if `descendantId` is `groupId` itself or nested anywhere under it. */
  private isInSubtree(groupId: LayerId, descendantId: LayerId): boolean {
    if (groupId === descendantId) return true;
    const g = this.nodes.get(groupId);
    if (!g || g.kind !== "group") return false;
    for (const childId of g.childrenIds) {
      if (this.isInSubtree(childId, descendantId)) return true;
    }
    return false;
  }

  /**
   * Serializable snapshot for React. Layers are emitted top -> bottom in a
   * depth-first walk so the LayersPanel can render them as a tree: a group row
   * is followed by its children (also top -> bottom), each carrying `depth`,
   * `parentId`, `isGroup` and `collapsed`. Children of a collapsed group are
   * still included (with a deeper depth); the UI hides them based on `collapsed`.
   */
  snapshot(): DocumentSnapshot {
    const layers: LayerSnapshot[] = [];
    const emit = (ids: readonly LayerId[], depth: number, parentId: LayerId | null) => {
      for (let i = ids.length - 1; i >= 0; i--) {
        const n = this.nodes.get(ids[i]!);
        if (!n) continue;
        const isAdj = n.kind === "adjustment";
        const isText = n.kind === "text";
        const isGroup = n.kind === "group";
        const isPixel = n.kind === "raster" || n.kind === "text";
        const clipping =
          isAdj || isPixel
            ? !!(n as AdjustmentLayer | PixelLayer).clipping
            : undefined;
        layers.push({
          id: n.id,
          kind: n.kind,
          name: n.name,
          visible: n.visible,
          opacity: n.opacity,
          blendMode: n.blendMode,
          width: isPixel ? (n as PixelLayer).width : this.width,
          height: isPixel ? (n as PixelLayer).height : this.height,
          hasMask: !!n.mask,
          maskEnabled: n.mask?.enabled ?? false,
          adjustmentType: isAdj ? (n as AdjustmentLayer).adjustmentType : undefined,
          // Clone params so React sees a fresh object each snapshot (live updates).
          params: isAdj ? structuredClone((n as AdjustmentLayer).params) : undefined,
          clipping,
          text: isText ? textSnapshot(n as TextLayer) : undefined,
          depth,
          parentId,
          isGroup,
          collapsed: isGroup ? (n as GroupLayer).collapsed : undefined,
          effects: isPixel ? effectsSummary((n as PixelLayer).effects) : undefined,
        });
        if (isGroup) {
          emit((n as GroupLayer).childrenIds, depth + 1, n.id);
        }
      }
    };
    emit(this.order, 0, null);
    return {
      width: this.width,
      height: this.height,
      layers,
      activeLayerId: this.activeLayerId,
    };
  }

  // ── mutations ───────────────────────────────────────────
  /**
   * Insert a freshly-created node directly ABOVE the active layer (in whatever
   * sibling list the active layer lives in), or at the top of the document root
   * when there is no active layer. Sets parentId accordingly and registers it in
   * `nodes`. Does NOT emit — callers do.
   */
  private insertAboveActive(node: LayerNode): void {
    this.nodes.set(node.id, node);
    const active = this.activeLayerId ? this.nodes.get(this.activeLayerId) : null;
    if (active) {
      const sib = this.siblingList(active.id);
      if (sib && sib.index >= 0) {
        (node as { parentId?: LayerId | null }).parentId =
          (active as { parentId?: LayerId | null }).parentId ?? null;
        sib.list.splice(sib.index + 1, 0, node.id);
        return;
      }
    }
    (node as { parentId?: LayerId | null }).parentId = null;
    this.order.push(node.id);
  }

  addRasterLayer(
    source: ImageBitmap | ImageData,
    name?: string,
    pos?: { x: number; y: number },
  ): LayerId {
    const id = nextId();
    const layer: RasterLayer = {
      id,
      kind: "raster",
      name: name ?? `Layer ${this.order.length + 1}`,
      visible: true,
      opacity: 1,
      blendMode: "normal",
      source,
      width: source.width,
      height: source.height,
      x: pos?.x ?? 0,
      y: pos?.y ?? 0,
      parentId: null,
    };
    this.nodes.set(id, layer);
    this.order.push(id); // new raster layers go on top of the root
    this.activeLayerId = id;
    // Grow the document to fit the first/largest layer if it's bigger.
    this.width = Math.max(this.width, layer.x + layer.width);
    this.height = Math.max(this.height, layer.y + layer.height);
    this.emit();
    return id;
  }

  /**
   * Insert a non-destructive adjustment layer directly ABOVE the active layer
   * (or on top when there is no active layer). Returns the new layer id.
   */
  addAdjustmentLayer(
    adjustmentType: AdjustmentType,
    params: AdjustmentParams,
    name?: string,
  ): LayerId {
    const id = nextId();
    const layer: AdjustmentLayer = {
      id,
      kind: "adjustment",
      name: name ?? defaultAdjustmentName(adjustmentType),
      visible: true,
      opacity: 1,
      blendMode: "normal",
      adjustmentType,
      params,
      clipping: false,
      parentId: null,
    };
    // Insert just above the active layer (same sibling list); default to root top.
    this.insertAboveActive(layer);
    this.activeLayerId = id;
    this.emit();
    return id;
  }

  /** Merge a patch into an adjustment layer's params (live tweak). */
  updateAdjustmentParams(id: LayerId, patch: AdjustmentParams): void {
    const n = this.nodes.get(id);
    if (!n || n.kind !== "adjustment") return;
    n.params = { ...n.params, ...patch };
    this.emit();
  }

  /** Replace an adjustment layer's params object wholesale (used by undo). */
  setAdjustmentParams(id: LayerId, params: AdjustmentParams): void {
    const n = this.nodes.get(id);
    if (!n || n.kind !== "adjustment") return;
    n.params = params;
    this.emit();
  }

  /**
   * Toggle clipping a layer to the single layer directly below it (within the
   * same group). Valid for adjustment, raster and text layers.
   */
  setClipping(id: LayerId, clipping: boolean): void {
    const n = this.nodes.get(id);
    if (!n) return;
    if (n.kind === "adjustment" || n.kind === "raster" || n.kind === "text") {
      (n as AdjustmentLayer | PixelLayer).clipping = clipping;
      this.emit();
    }
  }

  // ── layer effects (non-destructive styles) ──────────────
  /** Replace a pixel layer's effects bag wholesale (used by undo/live edits). */
  setEffects(id: LayerId, effects: LayerEffects | undefined): void {
    const n = this.nodes.get(id);
    if (!n || !isPixelLayer(n)) return;
    n.effects = effects;
    this.emit();
  }
  /** Snapshot a copy of a pixel layer's effects (for undo), or undefined. */
  getEffects(id: LayerId): LayerEffects | undefined {
    const n = this.nodes.get(id);
    if (!n || !isPixelLayer(n) || !n.effects) return undefined;
    return structuredClone(n.effects);
  }

  setActive(id: LayerId | null): void {
    if (id !== null && !this.nodes.has(id)) return;
    this.activeLayerId = id;
    this.emit();
  }

  setOpacity(id: LayerId, opacity: number): void {
    const n = this.nodes.get(id);
    if (!n) return;
    n.opacity = Math.max(0, Math.min(1, opacity));
    this.emit();
  }

  setVisible(id: LayerId, visible: boolean): void {
    const n = this.nodes.get(id);
    if (!n) return;
    n.visible = visible;
    this.emit();
  }

  setBlendMode(id: LayerId, mode: BlendMode): void {
    const n = this.nodes.get(id);
    if (!n) return;
    n.blendMode = mode;
    this.emit();
  }

  rename(id: LayerId, name: string): void {
    const n = this.nodes.get(id);
    if (!n) return;
    n.name = name;
    this.emit();
  }

  /** Move a layer one step within its OWN sibling list. dir > 0 = toward top. */
  reorder(id: LayerId, dir: number): void {
    const sib = this.siblingList(id);
    if (!sib || sib.index < 0) return;
    const { list, index: i } = sib;
    const j = i + (dir > 0 ? 1 : -1);
    if (j < 0 || j >= list.length) return;
    const tmp = list[i]!;
    list[i] = list[j]!;
    list[j] = tmp;
    this.emit();
  }

  /**
   * Remove a layer (or group, INCLUDING all its descendants) from the document.
   * Detaches it from its sibling list and deletes every node in its subtree.
   */
  remove(id: LayerId): void {
    const n = this.nodes.get(id);
    if (!n) return;
    // Detach from its sibling list.
    const sib = this.siblingList(id);
    if (sib && sib.index >= 0) sib.list.splice(sib.index, 1);
    // Collect + delete the whole subtree (groups remove their children too).
    const toDelete: LayerId[] = [];
    const collect = (nid: LayerId) => {
      const node = this.nodes.get(nid);
      if (!node) return;
      toDelete.push(nid);
      if (node.kind === "group") for (const c of node.childrenIds) collect(c);
    };
    collect(id);
    for (const d of toDelete) this.nodes.delete(d);
    if (this.activeLayerId !== null && toDelete.includes(this.activeLayerId)) {
      this.activeLayerId = this.order[this.order.length - 1] ?? null;
    }
    this.emit();
  }

  /** Set a layer's top-left position (move tool). No-op for adjustments/groups. */
  setPosition(id: LayerId, x: number, y: number): void {
    const n = this.nodes.get(id);
    if (!n || !isPixelLayer(n)) return;
    n.x = x;
    n.y = y;
    this.emit();
  }

  // ── groups ──────────────────────────────────────────────
  /** Create an empty group at the document root (top), make it active. */
  addGroup(name?: string): LayerId {
    const id = nextId();
    const group: GroupLayer = {
      id,
      kind: "group",
      name: name ?? "Group",
      visible: true,
      opacity: 1,
      blendMode: "normal",
      childrenIds: [],
      collapsed: false,
      parentId: null,
    };
    this.insertAboveActive(group);
    this.activeLayerId = id;
    this.emit();
    return id;
  }

  /**
   * Wrap the given layers in a NEW group. The group is inserted at the position
   * of the top-most selected layer within that layer's sibling list; the
   * selected layers are moved into the group preserving their relative order
   * (bottom -> top). Ids that are descendants of another selected group, or that
   * don't share a single common parent, are filtered to the ones living in the
   * top-most layer's sibling list (keeps the op well-defined). Returns the new
   * group id, or null if nothing groupable was supplied.
   */
  groupLayers(ids: LayerId[], name?: string): LayerId | null {
    const valid = ids.filter((id) => this.nodes.has(id));
    if (valid.length === 0) return null;
    // Anchor on the first valid id's sibling list; only group layers that live
    // in that same list (a coherent, reversible operation).
    const anchor = this.siblingList(valid[0]!);
    if (!anchor) return null;
    const parentList = anchor.list;
    const parentId =
      (this.nodes.get(valid[0]!) as { parentId?: LayerId | null }).parentId ?? null;
    // Selected ids that are direct members of this sibling list, in list order.
    const selectedSet = new Set(valid);
    const members = parentList.filter((cid) => selectedSet.has(cid));
    if (members.length === 0) return null;

    const groupId = nextId();
    const group: GroupLayer = {
      id: groupId,
      kind: "group",
      name: name ?? "Group",
      visible: true,
      opacity: 1,
      blendMode: "normal",
      childrenIds: [],
      collapsed: false,
      parentId,
    };
    this.nodes.set(groupId, group);

    // Insert the group where the TOP-most member was, then pull members out.
    const topIndex = Math.max(...members.map((m) => parentList.indexOf(m)));
    // Remove members from the parent list (descending index to keep positions).
    const memberIndices = members
      .map((m) => parentList.indexOf(m))
      .sort((a, b) => b - a);
    for (const idx of memberIndices) parentList.splice(idx, 1);
    // Insert the group at the (now-shifted) position of the old top member.
    let insertAt = parentList.length;
    // Find how many removed entries were below topIndex to adjust.
    const removedBelowTop = memberIndices.filter((i) => i < topIndex).length;
    insertAt = topIndex - removedBelowTop;
    insertAt = Math.max(0, Math.min(parentList.length, insertAt));
    parentList.splice(insertAt, 0, groupId);

    // Members keep their relative (bottom->top) order inside the group.
    group.childrenIds = members;
    for (const m of members) {
      (this.nodes.get(m) as { parentId?: LayerId | null }).parentId = groupId;
    }
    this.activeLayerId = groupId;
    this.emit();
    return groupId;
  }

  /**
   * Dissolve a group: splice its children back into the group's own sibling
   * list at the group's position (preserving order), then delete the group node.
   * No-op if `groupId` is not a group.
   */
  ungroup(groupId: LayerId): void {
    const g = this.nodes.get(groupId);
    if (!g || g.kind !== "group") return;
    const sib = this.siblingList(groupId);
    if (!sib || sib.index < 0) return;
    const { list, index } = sib;
    const parentId = g.parentId ?? null;
    const children = g.childrenIds.slice();
    // Replace the group entry with its children (same bottom->top order).
    list.splice(index, 1, ...children);
    for (const c of children) {
      (this.nodes.get(c) as { parentId?: LayerId | null }).parentId = parentId;
    }
    this.nodes.delete(groupId);
    if (this.activeLayerId === groupId) {
      this.activeLayerId = children[children.length - 1] ?? list[list.length - 1] ?? null;
    }
    this.emit();
  }

  /**
   * Move a layer into a group at a given child index (bottom -> top). Rejects
   * moving a group into itself or a descendant (would create a cycle). `index`
   * clamps into [0, children.length]. Pass index = -1 to append at the top.
   */
  moveLayerIntoGroup(id: LayerId, groupId: LayerId, index = -1): void {
    const node = this.nodes.get(id);
    const group = this.nodes.get(groupId);
    if (!node || !group || group.kind !== "group") return;
    if (this.isInSubtree(id, groupId)) return; // cycle guard
    // Detach from current sibling list.
    const sib = this.siblingList(id);
    if (sib && sib.index >= 0) sib.list.splice(sib.index, 1);
    const children = group.childrenIds;
    const at = index < 0 ? children.length : Math.max(0, Math.min(children.length, index));
    children.splice(at, 0, id);
    (node as { parentId?: LayerId | null }).parentId = groupId;
    this.emit();
  }

  /**
   * Move a layer to the document ROOT at a given index (bottom -> top). Used to
   * pull a layer out of a group. index = -1 appends at the top.
   */
  moveLayerToRoot(id: LayerId, index = -1): void {
    const node = this.nodes.get(id);
    if (!node) return;
    const sib = this.siblingList(id);
    if (sib && sib.index >= 0) sib.list.splice(sib.index, 1);
    const at = index < 0 ? this.order.length : Math.max(0, Math.min(this.order.length, index));
    this.order.splice(at, 0, id);
    (node as { parentId?: LayerId | null }).parentId = null;
    this.emit();
  }

  /** Collapse / expand a group (UI-only — collapsed groups still render). */
  setCollapsed(id: LayerId, collapsed: boolean): void {
    const n = this.nodes.get(id);
    if (!n || n.kind !== "group") return;
    n.collapsed = collapsed;
    this.emit();
  }

  // ── structure snapshot/restore (for undo of structural ops) ──
  /**
   * Capture the document's TREE STRUCTURE only (root order + each group's
   * children + every node's parentId), not pixels/params. Restoring this
   * reverts a group/ungroup/move without touching layer contents. Any group
   * node created by the captured op that no longer exists after restore is left
   * orphaned in `nodes` only if still referenced — callers pair this with
   * keeping the group node alive (group/ungroup operate in place).
   */
  captureStructure(): DocStructure {
    const groups: Record<LayerId, LayerId[]> = {};
    const parents: Record<LayerId, LayerId | null> = {};
    for (const [id, n] of this.nodes) {
      parents[id] = (n as { parentId?: LayerId | null }).parentId ?? null;
      if (n.kind === "group") groups[id] = n.childrenIds.slice();
    }
    return { root: this.order.slice(), groups, parents };
  }

  /**
   * Restore a previously captured structure. Group nodes referenced by the
   * structure must still exist (group/ungroup keep them alive via undo closures
   * that re-add them). Re-links every node's parentId + rebuilds child lists.
   */
  restoreStructure(s: DocStructure): void {
    this.order = s.root.slice();
    for (const [gid, kids] of Object.entries(s.groups)) {
      const g = this.nodes.get(gid);
      if (g && g.kind === "group") g.childrenIds = kids.slice();
    }
    for (const [id, pid] of Object.entries(s.parents)) {
      const n = this.nodes.get(id);
      if (n) (n as { parentId?: LayerId | null }).parentId = pid;
    }
    this.emit();
  }

  /** Re-attach a previously-removed node (used by structural undo). */
  reinsertNode(node: LayerNode): void {
    this.nodes.set(node.id, node);
  }

  /** Remove every layer (used when loading a project). Resets active. */
  clear(): void {
    this.nodes.clear();
    this.order = [];
    this.activeLayerId = null;
    this.emit();
  }

  /** All node ids (in no particular order) — for serialization. */
  allLayerIds(): LayerId[] {
    return [...this.nodes.keys()];
  }

  /** Set the document size directly (used when loading a project). */
  resize(width: number, height: number): void {
    this.width = width;
    this.height = height;
    this.emit();
  }

  // ── text layers ─────────────────────────────────────────
  /**
   * Create a text layer at document position (x,y). The engine rasterizes it and
   * fills in width/height/source via `setTextRaster`. Returns the new layer id.
   */
  addTextLayer(
    x: number,
    y: number,
    init: Partial<TextLayerPatch> = {},
  ): LayerId {
    const id = nextId();
    const text = init.text ?? "";
    const layer: TextLayer = {
      id,
      kind: "text",
      name: deriveTextName(text),
      visible: true,
      opacity: 1,
      blendMode: "normal",
      x,
      y,
      width: 1,
      height: 1,
      version: 1,
      text,
      fontFamily: init.fontFamily ?? "Inter, system-ui, sans-serif",
      fontSize: init.fontSize ?? 64,
      color: init.color ? { ...init.color } : { r: 0, g: 0, b: 0, a: 1 },
      align: init.align ?? "left",
      bold: init.bold ?? false,
      italic: init.italic ?? false,
      lineHeight: init.lineHeight ?? 1.2,
      parentId: null,
    };
    this.nodes.set(id, layer);
    this.order.push(id); // new layer on top of the root
    this.activeLayerId = id;
    this.emit();
    return id;
  }

  /**
   * Merge a typographic patch into a text layer. Bumps `version` so the engine
   * re-rasterizes, and re-derives the layer name when the text changed. The
   * caller is responsible for recording undo (see EditorEngine.commitTextLayer).
   */
  updateTextLayer(id: LayerId, patch: TextLayerPatch): void {
    const n = this.nodes.get(id);
    if (!n || n.kind !== "text") return;
    if (patch.text !== undefined) {
      n.text = patch.text;
      n.name = deriveTextName(patch.text);
    }
    if (patch.fontFamily !== undefined) n.fontFamily = patch.fontFamily;
    if (patch.fontSize !== undefined) n.fontSize = patch.fontSize;
    if (patch.color !== undefined) n.color = { ...patch.color };
    if (patch.align !== undefined) n.align = patch.align;
    if (patch.bold !== undefined) n.bold = patch.bold;
    if (patch.italic !== undefined) n.italic = patch.italic;
    if (patch.lineHeight !== undefined) n.lineHeight = patch.lineHeight;
    n.version += 1;
    this.emit();
  }

  /**
   * Replace ALL typographic params of a text layer wholesale (used by undo). The
   * snapshot omits geometry; the engine re-rasterizes from these params.
   */
  setTextLayerParams(id: LayerId, params: TextLayerSnapshot): void {
    const n = this.nodes.get(id);
    if (!n || n.kind !== "text") return;
    n.text = params.text;
    n.name = deriveTextName(params.text);
    n.fontFamily = params.fontFamily;
    n.fontSize = params.fontSize;
    n.color = { ...params.color };
    n.align = params.align;
    n.bold = params.bold;
    n.italic = params.italic;
    n.lineHeight = params.lineHeight;
    n.version += 1;
    this.emit();
  }

  /** Snapshot of a text layer's current typographic params (for undo). */
  getTextLayerParams(id: LayerId): TextLayerSnapshot | null {
    const n = this.nodes.get(id);
    if (!n || n.kind !== "text") return null;
    return textSnapshot(n);
  }

  /**
   * Convert a text layer into a plain raster layer IN PLACE (same id, order,
   * opacity, blendMode, mask preserved). Used when a transform is committed on a
   * text layer — its pixels are baked and it stops being editable text.
   */
  bakeTextToRaster(
    id: LayerId,
    source: ImageBitmap | ImageData,
    x: number,
    y: number,
  ): void {
    const n = this.nodes.get(id);
    if (!n || n.kind !== "text") return;
    const raster: RasterLayer = {
      id,
      kind: "raster",
      name: n.name,
      visible: n.visible,
      opacity: n.opacity,
      blendMode: n.blendMode,
      source,
      width: source.width,
      height: source.height,
      x,
      y,
      mask: n.mask,
    };
    this.nodes.set(id, raster);
    this.emit();
  }

  /**
   * Restore a baked raster layer back to an editable text layer (transform undo
   * on a text layer). Re-rasterized lazily by the engine from `params`.
   */
  unbakeTextFromRaster(
    id: LayerId,
    params: TextLayerSnapshot,
    x: number,
    y: number,
  ): void {
    const n = this.nodes.get(id);
    if (!n) return;
    const text: TextLayer = {
      id,
      kind: "text",
      name: deriveTextName(params.text),
      visible: n.visible,
      opacity: n.opacity,
      blendMode: n.blendMode,
      mask: n.mask,
      x,
      y,
      width: 1,
      height: 1,
      version: 1,
      text: params.text,
      fontFamily: params.fontFamily,
      fontSize: params.fontSize,
      color: { ...params.color },
      align: params.align,
      bold: params.bold,
      italic: params.italic,
      lineHeight: params.lineHeight,
    };
    this.nodes.set(id, text);
    this.emit();
  }

  /**
   * Store the engine-rasterized bitmap + its placement for a text layer. The
   * bitmap's top-left in doc space is (x,y). Does NOT emit (called inside the
   * render path); the engine markDirty()s itself.
   */
  setTextRaster(
    id: LayerId,
    source: ImageBitmap | ImageData,
    x: number,
    y: number,
  ): void {
    const n = this.nodes.get(id);
    if (!n || n.kind !== "text") return;
    n.source = source;
    n.width = source.width;
    n.height = source.height;
    n.x = x;
    n.y = y;
  }

  // ── layer masks ─────────────────────────────────────────
  /**
   * Attach a mask to a layer (creates an all-visible mask when `data` is
   * omitted). The mask is layer-local (same w/h as the layer).
   */
  addMask(id: LayerId, data?: Uint8Array): boolean {
    const n = this.nodes.get(id);
    if (!n || n.mask) return false;
    // Raster/text masks are layer-local; adjustment + group masks are full-doc.
    const fullDoc = n.kind === "adjustment" || n.kind === "group";
    const mw = fullDoc ? this.width : (n as PixelLayer).width;
    const mh = fullDoc ? this.height : (n as PixelLayer).height;
    const buf = data ?? new Uint8Array(mw * mh).fill(255);
    n.mask = {
      data: buf,
      width: mw,
      height: mh,
      version: 1,
      enabled: true,
    };
    this.emit();
    return true;
  }

  /** Remove a layer's mask entirely. */
  removeMask(id: LayerId): void {
    const n = this.nodes.get(id);
    if (!n || !n.mask) return;
    delete n.mask;
    this.emit();
  }

  setMaskEnabled(id: LayerId, enabled: boolean): void {
    const n = this.nodes.get(id);
    if (!n || !n.mask) return;
    n.mask.enabled = enabled;
    this.emit();
  }

  /** Mark a layer's mask dirty after an in-place edit (brush, fill). */
  bumpMaskVersion(id: LayerId): void {
    const n = this.nodes.get(id);
    if (!n || !n.mask) return;
    n.mask.version += 1;
    this.emit();
  }

  /** Replace a layer's raster source (e.g. after a flattened brush stroke). */
  replaceSource(id: LayerId, source: ImageBitmap | ImageData): void {
    const n = this.nodes.get(id);
    if (!n || n.kind !== "raster") return;
    n.source = source;
    n.width = source.width;
    n.height = source.height;
    this.emit();
  }
}
