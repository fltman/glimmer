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

export type LayerKind = "raster" | "adjustment";

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
}

export type LayerNode = RasterLayer | AdjustmentLayer;

/** Narrowing helpers. */
export function isRasterLayer(n: LayerNode): n is RasterLayer {
  return n.kind === "raster";
}
export function isAdjustmentLayer(n: LayerNode): n is AdjustmentLayer {
  return n.kind === "adjustment";
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
  /** Adjustment layers only: the adjustment type + live params + clipping. */
  adjustmentType?: AdjustmentType;
  params?: AdjustmentParams;
  clipping?: boolean;
}

export interface DocumentSnapshot {
  width: number;
  height: number;
  /** Ordered top -> bottom (index 0 is the top-most layer). */
  layers: LayerSnapshot[];
  activeLayerId: LayerId | null;
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

export class Document {
  width: number;
  height: number;

  /** Flat map of all layers. */
  private nodes = new Map<LayerId, LayerNode>();
  /** Ordered child ids, bottom -> top (matches compositing order). */
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
  /** Layer ids bottom -> top (compositing order). */
  orderBottomToTop(): readonly LayerId[] {
    return this.order;
  }
  getLayer(id: LayerId): LayerNode | undefined {
    return this.nodes.get(id);
  }
  getActiveLayerId(): LayerId | null {
    return this.activeLayerId;
  }

  /** Serializable snapshot for React, ordered top -> bottom. */
  snapshot(): DocumentSnapshot {
    const layers: LayerSnapshot[] = [];
    for (let i = this.order.length - 1; i >= 0; i--) {
      const n = this.nodes.get(this.order[i]!);
      if (!n) continue;
      const isAdj = n.kind === "adjustment";
      layers.push({
        id: n.id,
        kind: n.kind,
        name: n.name,
        visible: n.visible,
        opacity: n.opacity,
        blendMode: n.blendMode,
        width: isAdj ? this.width : (n as RasterLayer).width,
        height: isAdj ? this.height : (n as RasterLayer).height,
        hasMask: !!n.mask,
        maskEnabled: n.mask?.enabled ?? false,
        adjustmentType: isAdj ? (n as AdjustmentLayer).adjustmentType : undefined,
        // Clone params so React sees a fresh object each snapshot (live updates).
        params: isAdj ? structuredClone((n as AdjustmentLayer).params) : undefined,
        clipping: isAdj ? !!(n as AdjustmentLayer).clipping : undefined,
      });
    }
    return {
      width: this.width,
      height: this.height,
      layers,
      activeLayerId: this.activeLayerId,
    };
  }

  // ── mutations ───────────────────────────────────────────
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
    };
    this.nodes.set(id, layer);
    this.order.push(id); // new layer goes on top
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
    };
    this.nodes.set(id, layer);
    // Insert just above the active layer; default to top.
    const activeIdx =
      this.activeLayerId !== null ? this.order.indexOf(this.activeLayerId) : -1;
    if (activeIdx >= 0) this.order.splice(activeIdx + 1, 0, id);
    else this.order.push(id);
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

  /** Toggle clipping the adjustment to the single layer directly below. */
  setClipping(id: LayerId, clipping: boolean): void {
    const n = this.nodes.get(id);
    if (!n || n.kind !== "adjustment") return;
    n.clipping = clipping;
    this.emit();
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

  /** Move a layer one step in stack order. dir > 0 = toward top. */
  reorder(id: LayerId, dir: number): void {
    const i = this.order.indexOf(id);
    if (i < 0) return;
    const j = i + (dir > 0 ? 1 : -1);
    if (j < 0 || j >= this.order.length) return;
    const tmp = this.order[i]!;
    this.order[i] = this.order[j]!;
    this.order[j] = tmp;
    this.emit();
  }

  remove(id: LayerId): void {
    if (!this.nodes.has(id)) return;
    this.nodes.delete(id);
    const i = this.order.indexOf(id);
    if (i >= 0) this.order.splice(i, 1);
    if (this.activeLayerId === id) {
      this.activeLayerId = this.order[this.order.length - 1] ?? null;
    }
    this.emit();
  }

  /** Set a layer's top-left position (move tool). No-op for adjustments. */
  setPosition(id: LayerId, x: number, y: number): void {
    const n = this.nodes.get(id);
    if (!n || n.kind !== "raster") return;
    n.x = x;
    n.y = y;
    this.emit();
  }

  // ── layer masks ─────────────────────────────────────────
  /**
   * Attach a mask to a layer (creates an all-visible mask when `data` is
   * omitted). The mask is layer-local (same w/h as the layer).
   */
  addMask(id: LayerId, data?: Uint8Array): boolean {
    const n = this.nodes.get(id);
    if (!n || n.mask) return false;
    // Raster masks are layer-local; adjustment masks are full-document.
    const mw = n.kind === "adjustment" ? this.width : (n as RasterLayer).width;
    const mh = n.kind === "adjustment" ? this.height : (n as RasterLayer).height;
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
