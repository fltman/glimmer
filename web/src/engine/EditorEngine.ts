/**
 * EditorEngine — the imperative core. Owns the canvas, the WebGL2 Renderer, the
 * Document, the Selection, the BrushEngine, and the History. React never
 * touches pixels: it reads `getSnapshot()` via useSyncExternalStore and calls
 * the public methods.
 *
 * Phase 2 compositing: walk layers bottom->top with the FULL Photoshop blend
 * set. Because non-trivial blend modes read the backdrop, we ping-pong two
 * linear (RGBA16F or RGBA8) accumulators per layer (read A, write composited B,
 * swap). Layer masks (R8) and the document selection (R8) modulate each layer's
 * alpha in the blend shader. A present pass draws the checkerboard, encodes to
 * sRGB, and (when a selection exists) overlays animated marching ants.
 *
 * Tools route pointer events: Hand/space = pan, Move = translate active layer,
 * Brush/Eraser = paint, marquee/lasso = selection. View transform (pan/zoom) is
 * kept separate from document space. GL context loss is recoverable because the
 * Document keeps CPU pixel sources.
 */
import {
  WebGL2Renderer,
  type FramebufferHandle,
  type TextureHandle,
} from "./gl/Renderer";
import {
  QUAD_VERT,
  BLEND_NORMAL_FRAG,
  BLEND_FRAG,
  PRESENT_FRAG,
  ANTS_FRAG,
  STROKE_APPLY_FRAG,
  MASK_PAINT_FRAG,
  BLUR_FRAG,
  EFFECT_ALPHA_FRAG,
  EFFECT_FILL_FRAG,
  EFFECT_STROKE_FRAG,
  EFFECT_INNER_FRAG,
  EFFECT_INVERT_OFFSET_FRAG,
  EFFECT_OVER_FRAG,
} from "./gl/shaders";
import {
  Document,
  BLEND_MODE_INDEX,
  isAdjustmentLayer,
  isPixelLayer,
  isTextLayer,
  isGroupLayer,
  hasActiveEffects,
  type DocumentSnapshot,
  type LayerId,
  type LayerNode,
  type RasterLayer,
  type AdjustmentLayer,
  type AdjustmentType,
  type AdjustmentParams,
  type TextLayer,
  type PixelLayer,
  type GroupLayer,
  type TextLayerSnapshot,
  type TextLayerPatch,
  type LayerEffects,
  type LayerEffectType,
} from "../model/Document";
import * as m3 from "./math/mat3";
import {
  PathStore,
  cornerAnchor,
  tracePath,
  pathHasClosedRegion,
  type Path,
  type PathDescription,
  type FillRule,
} from "./Paths";
import { Selection } from "./Selection";
import { BrushEngine } from "./paint/BrushEngine";
import { RetouchEngine, type RetouchMode, type RetouchParams } from "./paint/RetouchEngine";
import { History, paramCommand } from "./history/History";
import {
  toolStore,
  isPaintTool,
  isRetouchTool,
  isSelectionTool,
  selectionOpFromEvent,
  type ToolId,
  type SelectionOp,
  type RGBAColor,
  type ShapeKind,
} from "../state/tools";
import {
  ADJUSTMENTS,
  defaultAdjustmentParams,
  sampleGradient,
  normalizeStops,
  type GradientStop,
} from "./adjustments";
import {
  FILTERS,
  defaultFilterParams,
  type FilterType,
  type FilterParams,
} from "./filters";

type Listener = () => void;

interface ViewState {
  /** Document-space px per screen px is 1/scale; scale = zoom factor. */
  scale: number;
  /** Pan offset in drawing-buffer pixels. */
  tx: number;
  ty: number;
}

/** GPU mask texture cache entry (keyed by layer id + version). */
interface MaskTexEntry {
  tex: TextureHandle;
  version: number;
}

/** A document-space rectangle (top-left origin). */
interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** A ruler guide: a horizontal (h) or vertical (v) line at `pos` doc px. */
export interface Guide {
  id: string;
  /** 'h' = a horizontal line (constant Y); 'v' = a vertical line (constant X). */
  axis: "h" | "v";
  /** Position in doc px (the Y for an 'h' guide, the X for a 'v' guide). */
  pos: number;
}

/** Grid display config (sizes in doc px). */
export interface GridState {
  visible: boolean;
  /** Major grid spacing in doc px. */
  size: number;
  /** Minor divisions per major cell (>=1). */
  subdivisions: number;
}

/**
 * The live free-transform expressed relative to the layer's base footprint:
 * translate (doc px), independent X/Y scale, rotation (degrees, CW on screen).
 * Identity = {dx:0,dy:0,scaleX:1,scaleY:1,rotDeg:0}.
 */
export interface TransformState {
  dx: number;
  dy: number;
  scaleX: number;
  scaleY: number;
  rotDeg: number;
}

/** The eight box handles + the four rotate zones outside the corners. */
export type TransformHandleId =
  | "nw" | "n" | "ne" | "e" | "se" | "s" | "sw" | "w";

/** What a transform drag is doing. */
type TransformDragMode = "move" | "scale" | "rotate";

/** What a crop drag is doing (which edge/corner, or move/new). */
type CropDragMode =
  | "new"
  | "move"
  | "nw" | "n" | "ne" | "e" | "se" | "s" | "sw" | "w";

const IDENTITY_TRANSFORM: TransformState = {
  dx: 0,
  dy: 0,
  scaleX: 1,
  scaleY: 1,
  rotDeg: 0,
};

export class EditorEngine {
  private canvas: HTMLCanvasElement | null = null;
  private renderer: WebGL2Renderer | null = null;
  readonly doc = new Document();
  readonly history = new History();

  /** Full blend shader (viewport). */
  private blendProgram: WebGLProgram | null = null;
  /** Normal-only blend shader kept for the export path (export.ts uses it). */
  private normalBlendProgram: WebGLProgram | null = null;
  private presentProgram: WebGLProgram | null = null;
  private antsProgram: WebGLProgram | null = null;
  private strokeApplyProgram: WebGLProgram | null = null;
  private maskPaintProgram: WebGLProgram | null = null;
  /** Plain RGBA blit (backdrop copy between ping-pong accumulators). */
  private copyProgram: WebGLProgram | null = null;

  // ── layer-effect programs (lazily compiled in initGL) ──
  private effectAlphaProgram: WebGLProgram | null = null;
  private effectFillProgram: WebGLProgram | null = null;
  private effectStrokeProgram: WebGLProgram | null = null;
  private effectInnerProgram: WebGLProgram | null = null;
  private effectInvertOffsetProgram: WebGLProgram | null = null;
  /** Premultiplied source-over of an effect quad, composited in-shader (no
   *  hardware blend into the float accumulator — see EFFECT_OVER_FRAG). */
  private effectOverProgram: WebGLProgram | null = null;
  private blurProgram: WebGLProgram | null = null;

  /** Ping-pong accumulators for backdrop-reading blend modes. */
  private accumA: FramebufferHandle | null = null;
  private accumB: FramebufferHandle | null = null;
  /** Full-screen scratch holding a backdrop snapshot while an effect quad is
   *  composited OVER it in-shader (can't read+write the same FBO). */
  private effectScratch: FramebufferHandle | null = null;

  private selection: Selection | null = null;
  private brush: BrushEngine | null = null;
  private retouch: RetouchEngine | null = null;

  /** Vector-path store (pen tool). CPU-only geometry; never touches GL. */
  readonly paths = new PathStore();

  /** GPU textures resolved lazily from the Document's CPU sources. */
  private textures = new Map<LayerId, TextureHandle>();
  private maskTextures = new Map<LayerId, MaskTexEntry>();

  /** Compiled adjustment programs, keyed by adjustment type. */
  private adjustmentPrograms = new Map<AdjustmentType, WebGLProgram>();
  /** Cached LUT textures for LUT-backed adjustments, keyed by layer id. */
  private adjustmentLUTs = new Map<LayerId, { tex: TextureHandle; key: string }>();
  /** Compiled filter programs, keyed by filter type. */
  private filterPrograms = new Map<FilterType, WebGLProgram>();

  /**
   * Active live filter preview, or null. While set, render() applies the filter
   * over the previewed layer's contribution (non-committed). commit/cancel
   * resolve it.
   */
  private filterPreview:
    | { layerId: LayerId; type: FilterType; params: FilterParams }
    | null = null;

  private view: ViewState = { scale: 1, tx: 0, ty: 0 };

  // ── rulers / guides / grid / snapping ───────────────────
  /** Document guides (positions in doc px). */
  private guides: Guide[] = [];
  private guideSeq = 0;
  /** Grid config (size + subdivisions in doc px). */
  private grid: GridState = { visible: false, size: 64, subdivisions: 4 };
  private rulersVisible = false;
  private snapEnabled = true;
  /** Live guide being dragged off a ruler (or null). UI overlay reads it. */
  private liveGuide: Guide | null = null;

  private dpr = 1;
  private dirty = true;
  private rafId = 0;
  private running = false;
  private listeners = new Set<Listener>();

  private snapshotCache: DocumentSnapshot;

  // Bound handlers.
  private onWheel = this.handleWheel.bind(this);
  private onPointerDown = this.handlePointerDown.bind(this);
  private onPointerMove = this.handlePointerMove.bind(this);
  private onPointerUp = this.handlePointerUp.bind(this);
  private onKeyDown = this.handleKeyDown.bind(this);
  private onKeyUp = this.handleKeyUp.bind(this);
  private onContextLost = this.handleContextLost.bind(this);
  private onContextRestored = this.handleContextRestored.bind(this);
  private resizeObserver: ResizeObserver | null = null;

  // Active-gesture state.
  private gesture:
    | { kind: "none" }
    | { kind: "pan" }
    | { kind: "move"; startX: number; startY: number; origX: number; origY: number; layerId: LayerId }
    | { kind: "paint"; layerId: LayerId; onMask: boolean }
    | { kind: "retouch"; layerId: LayerId; mode: RetouchMode }
    | { kind: "marquee"; shape: "rect" | "ellipse"; startDoc: { x: number; y: number }; op: ReturnType<typeof selectionOpFromEvent> }
    | { kind: "lasso"; pts: number[]; op: ReturnType<typeof selectionOpFromEvent> }
    | { kind: "gradient"; layerId: LayerId; from: { x: number; y: number }; to: { x: number; y: number } }
    | { kind: "transform"; mode: TransformDragMode; startDoc: { x: number; y: number }; start: TransformState; handle: TransformHandleId | null }
    | { kind: "crop"; mode: CropDragMode; startDoc: { x: number; y: number }; startRect: Rect }
    | { kind: "shape"; from: { x: number; y: number }; to: { x: number; y: number } }
    | { kind: "pen"; anchorPt: { x: number; y: number } } = {
    kind: "none",
  };
  /** Live gradient drag line (doc px) for a UI overlay, or null. */
  private liveGradient: { from: { x: number; y: number }; to: { x: number; y: number } } | null = null;
  private lastPointer = { x: 0, y: 0 };
  private spaceHeld = false;
  /** Live marquee preview rect in doc px (for overlay), or null. */
  private liveMarquee: { x0: number; y0: number; x1: number; y1: number } | null = null;

  // ── free-transform session ──────────────────────────────
  /**
   * The live transform applied to ONE layer at render time (multiplied into its
   * model matrix). `baseBounds` is the layer's doc-space footprint when the
   * session began; the transform is expressed relative to that box's center.
   * Null when no session is active.
   */
  private transformSession: {
    layerId: LayerId;
    base: TransformState;
    /** Doc-space layer footprint at session start. */
    baseBounds: Rect;
  } | null = null;

  // ── crop session ────────────────────────────────────────
  /** Live crop rectangle (doc px) or null when no crop session is active. */
  private cropSession: { rect: Rect } | null = null;

  // ── text editing ────────────────────────────────────────
  /** The text layer currently being edited via the UI overlay, or null. */
  private textEditing: { layerId: LayerId } | null = null;
  /** Re-rasterize cache: last version a text layer's bitmap was built for. */
  private textRasterVersion = new Map<LayerId, number>();

  /** Live shape drag (doc px) for the overlay preview, or null. */
  private liveShape: { kind: ShapeKind; from: { x: number; y: number }; to: { x: number; y: number } } | null = null;

  constructor() {
    this.snapshotCache = this.doc.snapshot();
    this.doc.onChange(() => {
      this.snapshotCache = this.doc.snapshot();
      this.markDirty();
      this.emit();
    });
    this.history.onChange(() => this.emit());
  }

  // ── lifecycle ───────────────────────────────────────────
  mount(canvas: HTMLCanvasElement): void {
    if (this.canvas === canvas && this.running) return;
    this.canvas = canvas;
    if (!this.renderer || (this.renderer.gl.isContextLost?.() ?? false)) {
      this.initGL();
    }

    canvas.addEventListener("wheel", this.onWheel, { passive: false });
    canvas.addEventListener("pointerdown", this.onPointerDown);
    canvas.addEventListener("pointermove", this.onPointerMove);
    window.addEventListener("pointerup", this.onPointerUp);
    window.addEventListener("keydown", this.onKeyDown);
    window.addEventListener("keyup", this.onKeyUp);
    canvas.addEventListener("webglcontextlost", this.onContextLost as EventListener);
    canvas.addEventListener(
      "webglcontextrestored",
      this.onContextRestored as EventListener,
    );

    this.resizeObserver = new ResizeObserver(() => this.markDirty());
    this.resizeObserver.observe(canvas);

    this.running = true;
    this.loop();
  }

  unmount(): void {
    this.running = false;
    cancelAnimationFrame(this.rafId);
    const c = this.canvas;
    if (c) {
      c.removeEventListener("wheel", this.onWheel);
      c.removeEventListener("pointerdown", this.onPointerDown);
      c.removeEventListener("pointermove", this.onPointerMove);
      window.removeEventListener("pointerup", this.onPointerUp);
      window.removeEventListener("keydown", this.onKeyDown);
      window.removeEventListener("keyup", this.onKeyUp);
      c.removeEventListener("webglcontextlost", this.onContextLost as EventListener);
      c.removeEventListener(
        "webglcontextrestored",
        this.onContextRestored as EventListener,
      );
    }
    this.resizeObserver?.disconnect();
    this.resizeObserver = null;
  }

  private initGL(): void {
    if (!this.canvas) return;
    this.renderer = new WebGL2Renderer(this.canvas);
    this.blendProgram = this.renderer.compileProgram(QUAD_VERT, BLEND_FRAG);
    this.normalBlendProgram = this.renderer.compileProgram(
      QUAD_VERT,
      BLEND_NORMAL_FRAG,
    );
    this.presentProgram = this.renderer.compileProgram(QUAD_VERT, PRESENT_FRAG);
    this.antsProgram = this.renderer.compileProgram(QUAD_VERT, ANTS_FRAG);
    this.strokeApplyProgram = this.renderer.compileProgram(
      QUAD_VERT,
      STROKE_APPLY_FRAG,
    );
    this.maskPaintProgram = this.renderer.compileProgram(
      QUAD_VERT,
      MASK_PAINT_FRAG,
    );
    this.effectAlphaProgram = this.renderer.compileProgram(QUAD_VERT, EFFECT_ALPHA_FRAG);
    this.effectFillProgram = this.renderer.compileProgram(QUAD_VERT, EFFECT_FILL_FRAG);
    this.effectStrokeProgram = this.renderer.compileProgram(QUAD_VERT, EFFECT_STROKE_FRAG);
    this.effectInnerProgram = this.renderer.compileProgram(QUAD_VERT, EFFECT_INNER_FRAG);
    this.effectInvertOffsetProgram = this.renderer.compileProgram(
      QUAD_VERT,
      EFFECT_INVERT_OFFSET_FRAG,
    );
    this.effectOverProgram = this.renderer.compileProgram(QUAD_VERT, EFFECT_OVER_FRAG);
    this.blurProgram = this.renderer.compileProgram(QUAD_VERT, BLUR_FRAG);
    this.copyProgram = this.renderer.compileProgram(
      QUAD_VERT,
      /* glsl */ `#version 300 es
precision highp float;
in vec2 v_uv; out vec4 fragColor;
uniform sampler2D u_src;
void main() { fragColor = texture(u_src, v_uv); }`,
    );
    this.selection = new Selection(this.renderer);
    this.selection.resize(this.doc.width, this.doc.height);
    this.brush = new BrushEngine(this.renderer);
    this.retouch = new RetouchEngine(this.renderer);
    this.markDirty();
  }

  // ── React bridge ────────────────────────────────────────
  subscribe(cb: Listener): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }
  getSnapshot(): DocumentSnapshot {
    return this.snapshotCache;
  }
  private emit(): void {
    for (const cb of this.listeners) cb();
  }

  markDirty(): void {
    this.dirty = true;
  }

  // ── image loading ───────────────────────────────────────
  async loadImageLayer(
    src: Blob | ImageBitmap | ImageData,
    name?: string,
  ): Promise<LayerId> {
    let bitmap: ImageBitmap | ImageData;
    if (src instanceof Blob) {
      bitmap = await createImageBitmap(src, {
        premultiplyAlpha: "none",
        colorSpaceConversion: "none",
      });
    } else {
      bitmap = src;
    }
    const id = this.doc.addRasterLayer(bitmap, name);
    if (this.doc.orderBottomToTop().length === 1) {
      this.fitToScreen();
    }
    // Keep the selection mask sized to the (possibly grown) document.
    this.selection?.resize(this.doc.width, this.doc.height);
    // Record an undo step for the layer add (cheap parametric).
    this.history.push(
      paramCommand(
        "Add layer",
        () => {}, // forward already applied
        () => this.doc.remove(id),
      ),
    );
    this.markDirty();
    return id;
  }

  /**
   * Place a layer at an absolute document position. Used by the AI action flow
   * to drop an inpaint/outpaint result back at its source ROI (loadImageLayer
   * always adds at 0,0). The engine track is merged with no parallel conflict.
   */
  setLayerPosition(id: LayerId, x: number, y: number): void {
    if (!this.doc.getLayer(id)) return;
    this.doc.setPosition(id, x, y);
    this.markDirty();
  }

  /**
   * Document-space geometry of a layer (the snapshot omits x/y so the AI flow
   * reads it here to export the layer's full-resolution region and to size
   * expand/upscale ops). Returns null if the layer no longer exists.
   */
  getLayerGeometry(
    id: LayerId,
  ): { x: number; y: number; width: number; height: number } | null {
    const l = this.doc.getLayer(id);
    if (!l) return null;
    // Adjustment + group layers cover the whole document; pixel layers (raster +
    // text) return their own footprint so the AI flow exports the right ROI.
    // Text layers must be rasterized first so width/height are populated.
    if (!isPixelLayer(l)) {
      return { x: 0, y: 0, width: this.doc.width, height: this.doc.height };
    }
    if (l.kind === "text") this.ensureTextRasterized(l);
    return { x: l.x, y: l.y, width: l.width, height: l.height };
  }

  // ── view transform ──────────────────────────────────────
  pan(dxBuffer: number, dyBuffer: number): void {
    this.view.tx += dxBuffer;
    this.view.ty += dyBuffer;
    this.markDirty();
  }

  zoomAt(factor: number, screenX: number, screenY: number): void {
    const bx = screenX * this.dpr;
    const by = screenY * this.dpr;
    const newScale = Math.max(0.02, Math.min(64, this.view.scale * factor));
    const k = newScale / this.view.scale;
    this.view.tx = bx - (bx - this.view.tx) * k;
    this.view.ty = by - (by - this.view.ty) * k;
    this.view.scale = newScale;
    this.markDirty();
  }

  getZoom(): number {
    return this.view.scale;
  }

  fitToScreen(): void {
    if (!this.canvas) return;
    const bw = this.canvas.width || 1;
    const bh = this.canvas.height || 1;
    const dw = this.doc.width || 1;
    const dh = this.doc.height || 1;
    const scale = Math.min(bw / dw, bh / dh) * 0.92;
    this.view.scale = scale;
    this.view.tx = (bw - dw * scale) / 2;
    this.view.ty = (bh - dh * scale) / 2;
    this.markDirty();
  }

  // ── coordinate helpers ──────────────────────────────────
  /** Screen (CSS px relative to canvas) -> document px. */
  private screenToDoc(screenX: number, screenY: number): { x: number; y: number } {
    const bx = screenX * this.dpr;
    const by = screenY * this.dpr;
    return {
      x: (bx - this.view.tx) / this.view.scale,
      y: (by - this.view.ty) / this.view.scale,
    };
  }

  // ── undo / redo ─────────────────────────────────────────
  undo(): void {
    this.history.undo();
    this.refreshAfterHistory();
  }
  redo(): void {
    this.history.redo();
    this.refreshAfterHistory();
  }
  canUndo(): boolean {
    return this.history.canUndo();
  }
  canRedo(): boolean {
    return this.history.canRedo();
  }
  private refreshAfterHistory(): void {
    // Pixel-restoring commands mutate CPU sources directly; drop GPU caches so
    // they re-resolve, then re-render + re-snapshot.
    this.textures.clear();
    this.maskTextures.clear();
    // Adjustment LUTs are keyed by param hash and re-resolve lazily, but drop
    // them so a removed/changed adjustment layer's stale LUT GPU texture goes.
    const r = this.renderer;
    if (r) for (const e of this.adjustmentLUTs.values()) r.deleteTexture(e.tex);
    this.adjustmentLUTs.clear();
    this.snapshotCache = this.doc.snapshot();
    this.markDirty();
    this.emit();
  }

  // ── selection API (also used by the AI flow) ────────────
  selectAll(): void {
    this.selection?.selectAll();
    this.markDirty();
    this.emit();
  }
  clearSelection(): void {
    this.selection?.clear();
    this.markDirty();
    this.emit();
  }
  hasSelection(): boolean {
    return !!this.selection && !this.selection.isEmpty();
  }
  /** Tight document-space bounds of the active selection, or null. */
  getSelectionMaskBounds(): { x: number; y: number; width: number; height: number } | null {
    return this.selection?.getBounds() ?? null;
  }

  /**
   * Export the selection mask within `roi` as a single-channel-encoded PNG
   * (white = selected). Used by inpaint. `roi` defaults to the selection bounds
   * (or the whole document when empty).
   */
  async exportSelectionMaskPNG(roi?: { x: number; y: number; width: number; height: number }): Promise<Blob> {
    const r = this.renderer;
    const sel = this.selection;
    if (!r || !sel || !sel.framebuffer) throw new Error("Engine not ready.");
    const region = roi ??
      sel.getBounds() ?? { x: 0, y: 0, width: this.doc.width, height: this.doc.height };
    const { width: dw, height: dh } = sel.size;
    // Selection targets are stored doc-top at framebuffer row 0, so the read is
    // top-down in doc space (no Y flip).
    const raw = r.readR8(sel.framebuffer, region.x, region.y, region.width, region.height);
    const out = new Uint8ClampedArray(region.width * region.height * 4);
    for (let y = 0; y < region.height; y++) {
      const srcRow = y * region.width;
      const dstRow = y * region.width * 4;
      for (let x = 0; x < region.width; x++) {
        const v = raw[srcRow + x] ?? 0;
        const d = dstRow + x * 4;
        out[d] = v;
        out[d + 1] = v;
        out[d + 2] = v;
        out[d + 3] = 255;
      }
    }
    void dw;
    void dh;
    return encodePng(out, region.width, region.height);
  }

  /**
   * Export the composited pixels of a single layer within `roi` as a PNG (the
   * source region inpaint regenerates). Renders just that layer at doc res.
   */
  async exportLayerRegionPNG(
    layerId: LayerId,
    roi: { x: number; y: number; width: number; height: number },
  ): Promise<Blob> {
    const r = this.renderer;
    const blend = this.normalBlendProgram;
    if (!r || !blend) throw new Error("Engine not ready.");
    const layer = this.doc.getLayer(layerId);
    const tex = this.resolveTexture(layerId);
    if (!layer || layer.kind !== "raster" || !tex) throw new Error("Layer not found.");
    const gl = r.gl;
    // RGBA8 (not float) target: this result is read back as bytes, which is an
    // invalid format combo on a float FBO and returns zeros.
    const target = r.createRGBA8Target(roi.width, roi.height);
    gl.bindFramebuffer(gl.FRAMEBUFFER, target.fbo);
    gl.viewport(0, 0, roi.width, roi.height);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.enable(gl.BLEND);
    gl.blendFuncSeparate(gl.ONE, gl.ONE_MINUS_SRC_ALPHA, gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    gl.useProgram(blend);
    // ROI px -> clip (translate by -roi origin so the region maps to [0,roi]).
    const pixToClip = m3.pixelToClip(roi.width, roi.height);
    const toDocPx = m3.multiply(
      m3.translation(layer.x - roi.x, layer.y - roi.y),
      m3.scaling(layer.width, layer.height),
    );
    const transform = m3.multiply(pixToClip, toDocPx);
    gl.uniformMatrix3fv(gl.getUniformLocation(blend, "u_transform"), false, transform);
    gl.uniform1f(gl.getUniformLocation(blend, "u_opacity"), 1);
    gl.uniform1i(gl.getUniformLocation(blend, "u_tex"), 0);
    gl.uniform1i(gl.getUniformLocation(blend, "u_srgbSource"), tex.srgb ? 0 : 1);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, tex.tex);
    r.drawQuad();
    gl.disable(gl.BLEND);

    const rawLinear = r.readPixels(target, 0, 0, roi.width, roi.height);
    r.deleteFramebuffer(target);
    const out = new Uint8ClampedArray(roi.width * roi.height * 4);
    for (let y = 0; y < roi.height; y++) {
      const srcRow = (roi.height - 1 - y) * roi.width * 4;
      const dstRow = y * roi.width * 4;
      for (let x = 0; x < roi.width * 4; x += 4) {
        const a = (rawLinear[srcRow + x + 3] ?? 0) / 255;
        const inv = a > 0.0001 ? 1 / a : 0;
        for (let ch = 0; ch < 3; ch++) {
          const lin = ((rawLinear[srcRow + x + ch] ?? 0) / 255) * inv;
          out[dstRow + x + ch] = Math.round(linearToSrgb(lin) * 255);
        }
        out[dstRow + x + 3] = rawLinear[srcRow + x + 3] ?? 0;
      }
    }
    return encodePng(out, roi.width, roi.height);
  }

  // ── layer masks ─────────────────────────────────────────
  /** Add a layer mask seeded from the current selection (or fully visible). */
  addLayerMaskFromSelection(layerId: LayerId): void {
    const layer = this.doc.getLayer(layerId);
    const r = this.renderer;
    const sel = this.selection;
    if (!layer || !r) return;
    let data: Uint8Array | undefined;
    if (sel && !sel.isEmpty() && sel.framebuffer) {
      if (layer.kind === "raster") {
        // Sample the selection over the layer's footprint into a layer-sized R8.
        data = this.sampleSelectionIntoLayer(layer);
      } else {
        // Adjustment masks are full-document — read the selection mask directly.
        const { width: dw, height: dh } = sel.size;
        const raw = r.readR8(sel.framebuffer, 0, 0, dw, dh);
        data = new Uint8Array(dw * dh);
        data.set(raw.subarray(0, dw * dh));
      }
    }
    if (this.doc.addMask(layerId, data)) {
      this.history.push(
        paramCommand(
          "Add layer mask",
          () => {},
          () => this.doc.removeMask(layerId),
        ),
      );
    }
    this.maskTextures.delete(layerId);
    this.markDirty();
  }

  /** Resample the doc selection into a layer-local R8 buffer (CPU readback). */
  private sampleSelectionIntoLayer(layer: RasterLayer): Uint8Array {
    const r = this.renderer!;
    const sel = this.selection!;
    const { width: dw, height: dh } = sel.size;
    const out = new Uint8Array(layer.width * layer.height); // default 0 (hidden)
    if (!sel.framebuffer) return out;
    // Read just the layer's footprint, clamped to the document.
    const x0 = Math.max(0, Math.round(layer.x));
    const y0 = Math.max(0, Math.round(layer.y));
    const x1 = Math.min(dw, Math.round(layer.x + layer.width));
    const y1 = Math.min(dh, Math.round(layer.y + layer.height));
    const rw = x1 - x0;
    const rh = y1 - y0;
    if (rw <= 0 || rh <= 0) return out;
    void dh;
    // Selection is stored doc-top-down; read the footprint directly.
    const raw = r.readR8(sel.framebuffer, x0, y0, rw, rh);
    for (let y = 0; y < rh; y++) {
      const srcRow = y * rw;
      const docY = y0 + y;
      const layerY = docY - Math.round(layer.y);
      if (layerY < 0 || layerY >= layer.height) continue;
      for (let x = 0; x < rw; x++) {
        const docX = x0 + x;
        const layerX = docX - Math.round(layer.x);
        if (layerX < 0 || layerX >= layer.width) continue;
        out[layerY * layer.width + layerX] = raw[srcRow + x] ?? 0;
      }
    }
    return out;
  }

  // ── context loss recovery ───────────────────────────────
  private handleContextLost(e: Event): void {
    e.preventDefault();
    this.textures.clear();
    this.maskTextures.clear();
    // Programs and GPU resources are gone with the context; drop the caches so
    // they recompile/re-resolve on restore.
    this.adjustmentPrograms.clear();
    this.adjustmentLUTs.clear();
    this.filterPrograms.clear();
    this.filterPreview = null;
    this.filterScratch = null;
    this._fillProg = null;
    this._gradProg = null;
    this._histProg = null;
    this._previewProg = null;
    this.effectAlphaProgram = null;
    this.effectFillProgram = null;
    this.effectStrokeProgram = null;
    this.effectInnerProgram = null;
    this.effectInvertOffsetProgram = null;
    this.effectOverProgram = null;
    this.effectScratch = null;
    this.blurProgram = null;
    this.accumA = null;
    this.accumB = null;
    this.selection?.dispose();
    this.selection = null;
    this.brush?.dispose();
    this.brush = null;
    this.retouch?.dispose();
    this.retouch = null;
  }
  private handleContextRestored(): void {
    this.initGL();
  }

  // ── texture resolution ──────────────────────────────────
  private resolveTexture(id: LayerId): TextureHandle | null {
    const cached = this.textures.get(id);
    if (cached) return cached;
    const r = this.renderer;
    const layer = this.doc.getLayer(id);
    if (!r || !layer || !isPixelLayer(layer)) return null; // adjustments have no pixels
    // Text layers carry pixels only after rasterization.
    if (layer.kind === "text") this.ensureTextRasterized(layer);
    const src = layer.source;
    if (!src) return null;
    let source: TexImageSource;
    if (typeof ImageData !== "undefined" && src instanceof ImageData) {
      const cv = document.createElement("canvas");
      cv.width = src.width;
      cv.height = src.height;
      cv.getContext("2d")!.putImageData(src, 0, 0);
      source = cv;
    } else {
      source = src as ImageBitmap;
    }
    const tex = r.createTextureFromSource(source, { srgb: true });
    this.textures.set(id, tex);
    return tex;
  }

  /** Resolve (and cache, by version) a layer's mask as an R8 texture. */
  private resolveMaskTexture(layer: LayerNode): TextureHandle | null {
    const r = this.renderer;
    if (!r || !layer.mask) return null;
    const cached = this.maskTextures.get(layer.id);
    if (cached && cached.version === layer.mask.version) return cached.tex;
    if (cached) r.deleteTexture(cached.tex);
    const tex = r.createR8Texture(layer.mask.data, layer.mask.width, layer.mask.height);
    this.maskTextures.set(layer.id, { tex, version: layer.mask.version });
    return tex;
  }

  // ── adjustment layers + filter preview ──────────────────
  /**
   * Resolve a raster layer's texture for compositing. When a live filter
   * preview is active on this layer, the texture is the filtered result;
   * otherwise it's the plain source texture.
   */
  private resolveLayerCompositeTexture(id: LayerId): TextureHandle | null {
    const base = this.resolveTexture(id);
    if (!base) return null;
    // Live retouch stroke: show the in-progress working copy for this layer.
    if (
      this.retouch &&
      this.retouch.isActive &&
      this.gesture.kind === "retouch" &&
      this.gesture.layerId === id
    ) {
      const work = this.retouch.workTexture;
      if (work) return work;
    }
    const fp = this.filterPreview;
    if (fp && fp.layerId === id) {
      const layer = this.doc.getLayer(id);
      if (layer && layer.kind === "raster") {
        const filtered = this.runFilterToTexture(layer, fp.type, fp.params);
        if (filtered) return filtered;
      }
    }
    return base;
  }

  /** Get (compiling on first use) the adjustment program for a type. */
  private adjustmentProgram(type: AdjustmentType): WebGLProgram | null {
    const r = this.renderer;
    if (!r) return null;
    let prog = this.adjustmentPrograms.get(type);
    if (!prog) {
      prog = r.compileProgram(QUAD_VERT, ADJUSTMENTS[type].fragSource);
      this.adjustmentPrograms.set(type, prog);
    }
    return prog;
  }

  /** Resolve (and cache, by param hash) the LUT texture for a LUT adjustment. */
  private resolveAdjustmentLUT(layer: AdjustmentLayer): TextureHandle | null {
    const r = this.renderer;
    const def = ADJUSTMENTS[layer.adjustmentType];
    if (!r || !def.needsLUT || !def.buildLUT) return null;
    const key = JSON.stringify(layer.params);
    const cached = this.adjustmentLUTs.get(layer.id);
    if (cached && cached.key === key) return cached.tex;
    if (cached) r.deleteTexture(cached.tex);
    const lut = def.buildLUT(layer.params);
    const tex = r.createRGBA8Texture(lut, 256, 1, { srgb: false });
    this.adjustmentLUTs.set(layer.id, { tex, key });
    return tex;
  }

  /**
   * Run an adjustment layer as a fullscreen pass: read the backdrop accumulator,
   * apply the adjustment (respecting opacity, mask, clipping), write to `write`.
   * The viewport (read/write) is in drawing-buffer pixels; the adjustment shader
   * samples the backdrop by v_uv. Mask + clip are sampled via uv->space matrices.
   */
  private renderAdjustmentLayer(
    layer: AdjustmentLayer,
    read: FramebufferHandle,
    write: FramebufferHandle,
    bw: number,
    bh: number,
    view: Float32Array,
    pixToClip: Float32Array,
  ): void {
    const r = this.renderer;
    if (!r) return;
    const gl = r.gl;
    const def = ADJUSTMENTS[layer.adjustmentType];
    const prog = this.adjustmentProgram(layer.adjustmentType);
    if (!prog) {
      // Unknown adjustment — pass the backdrop through unchanged.
      gl.bindFramebuffer(gl.FRAMEBUFFER, write.fbo);
      gl.viewport(0, 0, bw, bh);
      gl.disable(gl.BLEND);
      this.blitBackdrop(read);
      return;
    }

    gl.bindFramebuffer(gl.FRAMEBUFFER, write.fbo);
    gl.viewport(0, 0, bw, bh);
    gl.disable(gl.BLEND);
    gl.useProgram(prog);
    // Fullscreen quad: quad [0,1] -> clip [-1,1] directly (no Y flip; we sample
    // the backdrop by the same v_uv it was written with).
    gl.uniformMatrix3fv(
      gl.getUniformLocation(prog, "u_transform"),
      false,
      new Float32Array([2, 0, 0, 0, 2, 0, -1, -1, 1]),
    );
    const loc = (n: string) => gl.getUniformLocation(prog, n);
    gl.uniform1i(loc("u_backdrop"), 0);
    gl.uniform2f(loc("u_backdropSize"), bw, bh);
    gl.uniform1f(loc("u_amount"), layer.opacity);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, read.color.tex);

    // Layer mask (full-document R8). Viewport uv -> doc uv -> mask uv.
    const maskTex = layer.mask?.enabled ? this.resolveMaskTexture(layer) : null;
    gl.uniform1i(loc("u_useMask"), maskTex ? 1 : 0);
    if (maskTex) {
      // Viewport uv (0..1 over the drawing buffer) maps to doc space via the
      // inverse of (pixToClip*view) re-expressed in uv. Easiest: build the
      // forward uv->maskUv matrix. A viewport-uv point p (0..1) corresponds to
      // buffer px = p*size; doc px = (bufferPx - view.t)/view.scale; maskUv =
      // docPx / [maskW,maskH]. We assemble that affine directly.
      const m = this.viewportUvToDocUv(bw, bh, layer.mask!.width, layer.mask!.height);
      gl.uniformMatrix3fv(loc("u_uvToMask"), false, m);
      gl.uniform1i(loc("u_mask"), 2);
      gl.activeTexture(gl.TEXTURE2);
      gl.bindTexture(gl.TEXTURE_2D, maskTex.tex);
    }

    // Clipping: clip to the single layer directly below (its alpha).
    const clipTex = layer.clipping ? this.resolveClipTexture(layer.id) : null;
    gl.uniform1i(loc("u_useClip"), clipTex ? 1 : 0);
    if (clipTex) {
      const cl = this.doc.getLayer(clipTex.layerId)! as PixelLayer;
      const m = this.viewportUvToLayerUv(bw, bh, cl);
      gl.uniformMatrix3fv(loc("u_uvToClip"), false, m);
      gl.uniform1i(loc("u_clip"), 3);
      gl.activeTexture(gl.TEXTURE3);
      gl.bindTexture(gl.TEXTURE_2D, clipTex.tex.tex);
    }

    // LUT (levels/curves/gradient_map).
    if (def.needsLUT) {
      const lut = this.resolveAdjustmentLUT(layer);
      if (lut) {
        gl.uniform1i(loc("u_lut"), 4);
        gl.activeTexture(gl.TEXTURE4);
        gl.bindTexture(gl.TEXTURE_2D, lut.tex);
      }
    }

    // Adjustment-specific scalar/vector params.
    def.setUniforms?.(gl, loc, layer.params);

    r.drawQuad();
    void view;
    void pixToClip;
  }

  /**
   * The clip BASE for a clipped layer: the first PIXEL layer (raster or text)
   * directly below it within the SAME sibling list (group children or root),
   * skipping intervening adjustment layers. Returns its texture + id, or null.
   */
  private resolveClipTexture(
    clippedId: LayerId,
  ): { tex: TextureHandle; layerId: LayerId } | null {
    const node = this.doc.getLayer(clippedId);
    if (!node) return null;
    const parentId = (node as { parentId?: LayerId | null }).parentId ?? null;
    const siblings = parentId ? this.doc.childrenOf(parentId) : this.doc.orderBottomToTop();
    const idx = siblings.indexOf(clippedId);
    for (let i = idx - 1; i >= 0; i--) {
      const below = this.doc.getLayer(siblings[i]!);
      if (!below) continue;
      if (isPixelLayer(below)) {
        const tex = this.resolveTexture(below.id);
        if (tex) return { tex, layerId: below.id };
        return null;
      }
      // Skip adjustment layers; stop at a group (can't clip across a group).
      if (below.kind === "adjustment") continue;
      break;
    }
    return null;
  }

  /**
   * Affine mapping one pixel layer's quad uv [0,1] -> another pixel layer's quad
   * uv [0,1], both placed in DOC space. Used when clipping layer A to the alpha
   * of the layer B directly below it: a fragment at A-uv corresponds to doc px
   * (A.x + uvx*A.w, A.y + uvy*A.h); express that as B-uv. Ignores the live
   * transform (clip base uses its static footprint), which matches Photoshop's
   * "clip to the layer below" semantics for the common case.
   */
  private layerUvToLayerUv(a: PixelLayer, b: PixelLayer): Float32Array {
    const aw = a.width || 1;
    const ah = a.height || 1;
    const bw = b.width || 1;
    const bh = b.height || 1;
    const sx = aw / bw;
    const sy = ah / bh;
    const tx = (a.x - b.x) / bw;
    const ty = (a.y - b.y) / bh;
    // column-major affine: [sx,0,0, 0,sy,0, tx,ty,1]
    return new Float32Array([sx, 0, 0, 0, sy, 0, tx, ty, 1]);
  }

  /**
   * Affine mapping a viewport-uv point (0..1 over the drawing buffer, +y down in
   * uv since the adjustment quad samples v_uv directly) to a document-uv point
   * (0..1 over the document), then scaled to a target buffer's uv. For masks the
   * target is the full document so docUv == maskUv.
   */
  private viewportUvToDocUv(
    bw: number,
    bh: number,
    _targetW: number,
    _targetH: number,
  ): Float32Array {
    // The fullscreen adjustment quad has no Y-flip (v_uv.y=0 at framebuffer
    // row 0), but the backdrop was written with pixToClip's Y-flip, so the
    // fragment at v_uv shows doc point docX=(v_uv.x*bw - tx)/scale, and
    // docY=(bh*(1-v_uv.y) - ty)/scale. Mask/clip textures store row 0 = doc-top
    // (no flip), so docUv needs the Y inversion baked in here.
    const s = this.view.scale;
    const dw = this.doc.width;
    const dh = this.doc.height;
    const ax = bw / (s * dw);
    const ayNeg = -bh / (s * dh);
    const tx = -this.view.tx / (s * dw);
    const ty = (bh - this.view.ty) / (s * dh);
    // column-major: [ax,0,0, 0,ayNeg,0, tx,ty,1]
    return new Float32Array([ax, 0, 0, 0, ayNeg, 0, tx, ty, 1]);
  }

  /** Viewport-uv -> a specific pixel layer's local uv (for clipping). */
  private viewportUvToLayerUv(bw: number, bh: number, layer: PixelLayer): Float32Array {
    // Same flip rationale as viewportUvToDocUv; offset by the layer origin.
    const s = this.view.scale;
    const lw = layer.width;
    const lh = layer.height;
    const ax = bw / (s * lw);
    const ayNeg = -bh / (s * lh);
    const tx = (-this.view.tx - layer.x * s) / (s * lw);
    const ty = (bh - this.view.ty - layer.y * s) / (s * lh);
    return new Float32Array([ax, 0, 0, 0, ayNeg, 0, tx, ty, 1]);
  }

  // ── render loop ─────────────────────────────────────────
  private loop(): void {
    if (!this.running) return;
    this.rafId = requestAnimationFrame(() => this.loop());
    this.syncDrawingBuffer();
    // Marching ants animate continuously while a selection exists.
    if (this.hasSelection() || this.liveMarquee || this.gesture.kind === "lasso") {
      this.markDirty();
    }
    if (this.dirty) {
      this.render();
      this.dirty = false;
    }
  }

  private syncDrawingBuffer(): void {
    const c = this.canvas;
    const r = this.renderer;
    if (!c || !r) return;
    this.dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = Math.max(1, Math.round(c.clientWidth * this.dpr));
    const h = Math.max(1, Math.round(c.clientHeight * this.dpr));
    if (c.width !== w || c.height !== h) {
      r.resizeDrawingBuffer(w, h);
      this.markDirty();
    }
  }

  private ensureAccums(w: number, h: number): void {
    const r = this.renderer!;
    if (this.accumA && this.accumA.width === w && this.accumA.height === h) return;
    if (this.accumA) r.deleteFramebuffer(this.accumA);
    if (this.accumB) r.deleteFramebuffer(this.accumB);
    this.accumA = r.createColorTarget(w, h);
    this.accumB = r.createColorTarget(w, h);
  }

  /** Copy `src`'s color into the currently-bound framebuffer (fullscreen). */
  private blitBackdrop(src: FramebufferHandle): void {
    const r = this.renderer!;
    const gl = r.gl;
    const prog = this.copyProgram!;
    gl.useProgram(prog);
    gl.uniformMatrix3fv(
      gl.getUniformLocation(prog, "u_transform"),
      false,
      new Float32Array([2, 0, 0, 0, 2, 0, -1, -1, 1]),
    );
    gl.uniform1i(gl.getUniformLocation(prog, "u_src"), 0);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, src.color.tex);
    r.drawQuad();
  }

  private render(): void {
    const r = this.renderer;
    const c = this.canvas;
    if (!r || !c || !this.blendProgram || !this.presentProgram) return;
    const gl = r.gl;
    const bw = c.width;
    const bh = c.height;

    this.ensureAccums(bw, bh);
    let read = this.accumA!;
    let write = this.accumB!;

    // Clear the initial backdrop.
    gl.bindFramebuffer(gl.FRAMEBUFFER, read.fbo);
    gl.viewport(0, 0, bw, bh);
    gl.disable(gl.BLEND);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);

    const pixToClip = m3.pixelToClip(bw, bh);
    const view = m3.multiply(
      m3.translation(this.view.tx, this.view.ty),
      m3.scaling(this.view.scale, this.view.scale),
    );
    const activeId = this.doc.getActiveLayerId();

    // Composite the document tree (groups recurse into isolated buffers) into
    // the ping-pong accumulators; `read` ends up holding the final composite.
    const res = this.compositeList(
      this.doc.orderBottomToTop(),
      read,
      write,
      bw,
      bh,
      view,
      pixToClip,
      /*allowBrushPreview*/ true,
    );
    read = res.read;
    write = res.write;

    // Present pass.
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, bw, bh);
    gl.disable(gl.BLEND);
    gl.clearColor(0.06, 0.06, 0.07, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.useProgram(this.presentProgram);
    const pp = this.presentProgram;
    gl.uniformMatrix3fv(
      gl.getUniformLocation(pp, "u_transform"),
      false,
      new Float32Array([2, 0, 0, 0, 2, 0, -1, -1, 1]),
    );
    gl.uniform1i(gl.getUniformLocation(pp, "u_composite"), 0);
    gl.uniform2f(gl.getUniformLocation(pp, "u_viewport"), bw, bh);
    gl.uniform1f(gl.getUniformLocation(pp, "u_checkSize"), 12 * this.dpr);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, read.color.tex);
    r.drawQuad();
    void activeId;

    // Marching-ants overlay (committed selection contour).
    this.renderAnts(bw, bh, pixToClip, view);
    // Live marquee preview outline (rect/ellipse drag).
    this.renderLiveMarquee();
  }

  // ════════════════════════════════════════════════════════
  //  TREE COMPOSITOR (groups + clipping + effects)
  // ════════════════════════════════════════════════════════
  /**
   * Composite an ordered (bottom -> top) list of layer ids into a ping-pong
   * pair of accumulators. The caller seeds `read` (typically cleared to
   * transparent); this folds every layer in, swapping read/write per layer, and
   * returns the (possibly swapped) pair where `read` holds the final composite.
   *
   * Groups recurse: a group's children composite into a FRESH isolated pair of
   * accumulators (same buffer size), and the result is blended into the parent
   * as a single premultiplied-linear quad with the group's opacity/blend/mask.
   *
   * `view`/`pixToClip` carry the viewport (render) or identity (export) mapping;
   * children use the same mapping as the parent so placement stays consistent.
   */
  private compositeList(
    ids: readonly LayerId[],
    read: FramebufferHandle,
    write: FramebufferHandle,
    bw: number,
    bh: number,
    view: Float32Array,
    pixToClip: Float32Array,
    allowBrushPreview: boolean,
  ): { read: FramebufferHandle; write: FramebufferHandle } {
    const r = this.renderer;
    if (!r) return { read, write };

    for (const id of ids) {
      const layer = this.doc.getLayer(id);
      if (!layer || !layer.visible || layer.opacity <= 0) continue;

      // Adjustment layers: fullscreen pass over the current accumulator.
      if (isAdjustmentLayer(layer)) {
        this.renderAdjustmentLayer(layer, read, write, bw, bh, view, pixToClip);
        const swp = read; read = write; write = swp;
        continue;
      }

      // Group layers: composite children in isolation, then blend the result.
      if (isGroupLayer(layer)) {
        this.renderGroupLayer(layer, read, write, bw, bh, view, pixToClip);
        const swp = read; read = write; write = swp;
        continue;
      }

      // Pixel layers (raster / text), with optional layer effects + clipping.
      const tex = this.resolveLayerCompositeTexture(id);
      if (!tex) continue;
      const gl = r.gl;

      const fx = (layer as PixelLayer).effects;
      const hasFx = hasActiveEffects(fx);
      // BELOW-the-layer effects (drop shadow, outer glow) must live in the
      // BACKDROP the layer composites over — otherwise the layer-quad pass (blend
      // disabled, full-replace) overwrites the shadow with the un-shadowed
      // backdrop everywhere the layer is transparent inside its bounding box (a
      // text/shape drop shadow would be clipped to the quad rect). Draw them into
      // `read` first, then blit read->write so the shadow is carried through.
      if (hasFx) this.renderLayerEffectsBelow(layer as PixelLayer, tex, read, bw, bh, view, pixToClip);

      // Copy the (now shadow-bearing) backdrop into `write` so fragments outside
      // the layer quad are preserved, then draw the layer + on-top effects.
      gl.bindFramebuffer(gl.FRAMEBUFFER, write.fbo);
      gl.viewport(0, 0, bw, bh);
      gl.disable(gl.BLEND);
      this.blitBackdrop(read);

      this.drawPixelLayerQuad(layer as PixelLayer, tex, read, write, bw, bh, view, pixToClip);
      if (hasFx) this.renderLayerEffectsAbove(layer as PixelLayer, tex, write, bw, bh, view, pixToClip);

      // Live brush preview: composite the wet stroke over THIS layer in place.
      if (
        allowBrushPreview &&
        this.brush &&
        this.brush.isActive &&
        this.gesture.kind === "paint" &&
        this.gesture.layerId === id &&
        !this.gesture.onMask
      ) {
        this.compositeBrushPreview(write, layer as PixelLayer);
      }

      const swp = read; read = write; write = swp;
    }
    return { read, write };
  }

  /**
   * Draw a single pixel layer's quad into `write` (which already holds a copy of
   * the backdrop `read`). Uses the full blend shader, honouring the layer's
   * mask, blend mode, opacity and clipping-to-the-layer-below.
   */
  private drawPixelLayerQuad(
    layer: PixelLayer,
    tex: TextureHandle,
    read: FramebufferHandle,
    write: FramebufferHandle,
    bw: number,
    bh: number,
    view: Float32Array,
    pixToClip: Float32Array,
  ): void {
    const r = this.renderer;
    const P = this.blendProgram;
    if (!r || !P) return;
    const gl = r.gl;
    const toDocPx = this.layerModelMatrix(layer);
    const transform = m3.multiply(pixToClip, m3.multiply(view, toDocPx));

    gl.bindFramebuffer(gl.FRAMEBUFFER, write.fbo);
    gl.viewport(0, 0, bw, bh);
    gl.disable(gl.BLEND);
    gl.useProgram(P);
    gl.uniform1i(gl.getUniformLocation(P, "u_tex"), 0);
    gl.uniform1i(gl.getUniformLocation(P, "u_backdrop"), 1);
    gl.uniform1i(gl.getUniformLocation(P, "u_mask"), 2);
    gl.uniform1i(gl.getUniformLocation(P, "u_selection"), 3);
    gl.uniform1i(gl.getUniformLocation(P, "u_clip"), 5);
    gl.uniformMatrix3fv(gl.getUniformLocation(P, "u_transform"), false, transform);
    gl.uniform1f(gl.getUniformLocation(P, "u_opacity"), layer.opacity);
    gl.uniform1i(gl.getUniformLocation(P, "u_srgbSource"), tex.srgb ? 0 : 1);
    gl.uniform1i(gl.getUniformLocation(P, "u_premulSource"), 0);
    gl.uniform1i(gl.getUniformLocation(P, "u_blendMode"), BLEND_MODE_INDEX[layer.blendMode]);
    gl.uniform2f(gl.getUniformLocation(P, "u_backdropSize"), bw, bh);
    gl.uniform1i(gl.getUniformLocation(P, "u_useSelection"), 0);

    const maskTex = layer.mask?.enabled ? this.resolveMaskTexture(layer) : null;
    gl.uniform1i(gl.getUniformLocation(P, "u_useMask"), maskTex ? 1 : 0);
    if (maskTex) {
      gl.activeTexture(gl.TEXTURE2);
      gl.bindTexture(gl.TEXTURE_2D, maskTex.tex);
    }

    // Clipping: clip this layer to the alpha of the layer directly below it.
    const clip = layer.clipping ? this.resolveClipTexture(layer.id) : null;
    gl.uniform1i(gl.getUniformLocation(P, "u_useClip"), clip ? 1 : 0);
    if (clip) {
      const cl = this.doc.getLayer(clip.layerId) as PixelLayer;
      gl.uniformMatrix3fv(
        gl.getUniformLocation(P, "u_uvToClip"),
        false,
        this.layerUvToLayerUv(layer, cl),
      );
      gl.activeTexture(gl.TEXTURE5);
      gl.bindTexture(gl.TEXTURE_2D, clip.tex.tex);
    }

    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, read.color.tex);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, tex.tex);
    r.drawQuad();
  }

  /**
   * Composite a group's children into an isolated buffer, then blend that buffer
   * into the parent `write` (which holds a copy of `read`) with the group's
   * opacity / blend mode / mask. Premultiplied-linear group result.
   */
  private renderGroupLayer(
    group: GroupLayer,
    read: FramebufferHandle,
    write: FramebufferHandle,
    bw: number,
    bh: number,
    view: Float32Array,
    pixToClip: Float32Array,
  ): void {
    const r = this.renderer;
    const P = this.blendProgram;
    if (!r || !P) return;
    const gl = r.gl;

    // Isolated accumulators for the children (transparent backdrop).
    let gread = r.createColorTarget(bw, bh);
    let gwrite = r.createColorTarget(bw, bh);
    gl.bindFramebuffer(gl.FRAMEBUFFER, gread.fbo);
    gl.viewport(0, 0, bw, bh);
    gl.disable(gl.BLEND);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);

    const res = this.compositeList(
      group.childrenIds,
      gread,
      gwrite,
      bw,
      bh,
      view,
      pixToClip,
      /*allowBrushPreview*/ true,
    );
    gread = res.read;
    gwrite = res.write;

    // Backdrop copy already done by the caller into `write`. Blend the group
    // result (premultiplied linear) as a fullscreen quad with the group's
    // blend/opacity/mask. Identity quad placement (the group buffer is already
    // in viewport space).
    gl.bindFramebuffer(gl.FRAMEBUFFER, write.fbo);
    gl.viewport(0, 0, bw, bh);
    gl.disable(gl.BLEND);
    gl.useProgram(P);
    gl.uniform1i(gl.getUniformLocation(P, "u_tex"), 0);
    gl.uniform1i(gl.getUniformLocation(P, "u_backdrop"), 1);
    gl.uniform1i(gl.getUniformLocation(P, "u_mask"), 2);
    gl.uniform1i(gl.getUniformLocation(P, "u_selection"), 3);
    gl.uniformMatrix3fv(
      gl.getUniformLocation(P, "u_transform"),
      false,
      new Float32Array([2, 0, 0, 0, 2, 0, -1, -1, 1]),
    );
    gl.uniform1f(gl.getUniformLocation(P, "u_opacity"), group.opacity);
    gl.uniform1i(gl.getUniformLocation(P, "u_srgbSource"), 0);
    gl.uniform1i(gl.getUniformLocation(P, "u_premulSource"), 1);
    gl.uniform1i(gl.getUniformLocation(P, "u_blendMode"), BLEND_MODE_INDEX[group.blendMode]);
    gl.uniform2f(gl.getUniformLocation(P, "u_backdropSize"), bw, bh);
    gl.uniform1i(gl.getUniformLocation(P, "u_useMask"), 0);
    gl.uniform1i(gl.getUniformLocation(P, "u_useClip"), 0);

    // Group mask: a full-document R8 mask. The blend shader's u_mask samples by
    // v_uv (layer-local), but our quad is fullscreen so v_uv == viewport uv,
    // which is NOT doc uv under a non-identity view. The selection path samples
    // u_selection with a uv->docUv matrix (u_uvToSel) — structurally identical
    // to a full-document mask — so reuse it to apply the group mask correctly.
    const maskTex = group.mask?.enabled ? this.resolveMaskTexture(group) : null;
    gl.uniform1i(gl.getUniformLocation(P, "u_useSelection"), maskTex ? 1 : 0);
    if (maskTex) {
      gl.uniformMatrix3fv(
        gl.getUniformLocation(P, "u_uvToSel"),
        false,
        this.viewportUvToDocUv(bw, bh, group.mask!.width, group.mask!.height),
      );
      gl.activeTexture(gl.TEXTURE3);
      gl.bindTexture(gl.TEXTURE_2D, maskTex.tex);
    }

    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, read.color.tex);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, gread.color.tex);
    r.drawQuad();

    r.deleteFramebuffer(gread);
    r.deleteFramebuffer(gwrite);
  }

  // ════════════════════════════════════════════════════════
  //  LAYER STYLES / EFFECTS (rendered around the layer quad)
  // ════════════════════════════════════════════════════════
  /**
   * Build a single-channel (R8) alpha buffer for a layer's shape, padded by
   * `pad` doc px on every side so blurred shadows/glows can extend beyond the
   * footprint. Returns the buffer + the doc-space rect it covers. `choke` (0..1)
   * thickens the alpha (drop-shadow spread). Caller deletes the FBO.
   */
  private buildLayerAlpha(
    layer: PixelLayer,
    tex: TextureHandle,
    pad: number,
    choke: number,
  ): { fb: FramebufferHandle; rect: Rect } | null {
    const r = this.renderer;
    const prog = this.effectAlphaProgram;
    if (!r || !prog) return null;
    const gl = r.gl;
    const rect: Rect = {
      x: layer.x - pad,
      y: layer.y - pad,
      width: Math.max(1, Math.round(layer.width + pad * 2)),
      height: Math.max(1, Math.round(layer.height + pad * 2)),
    };
    const fb = r.createR8Target(rect.width, rect.height);
    gl.bindFramebuffer(gl.FRAMEBUFFER, fb.fbo);
    gl.viewport(0, 0, rect.width, rect.height);
    gl.disable(gl.BLEND);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.useProgram(prog);
    // Place the layer's footprint quad inside the padded rect (no Y flip; the
    // alpha buffer is sampled with the same uv it's written with by later passes).
    const pixToRect = new Float32Array([2 / rect.width, 0, 0, 0, 2 / rect.height, 0, -1, -1, 1]);
    const toRectPx = m3.multiply(
      m3.translation(layer.x - rect.x, layer.y - rect.y),
      m3.scaling(layer.width, layer.height),
    );
    gl.uniformMatrix3fv(gl.getUniformLocation(prog, "u_transform"), false, m3.multiply(pixToRect, toRectPx));
    gl.uniform1f(gl.getUniformLocation(prog, "u_choke"), choke);
    gl.uniform1i(gl.getUniformLocation(prog, "u_tex"), 0);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, tex.tex);
    r.drawQuad();
    return { fb, rect };
  }

  /** Separable Gaussian blur of an R8 buffer in place (ping-pong). Returns the result FBO. */
  private blurR8(src: FramebufferHandle, radiusPx: number): FramebufferHandle {
    const r = this.renderer;
    const prog = this.blurProgram;
    if (!r || !prog || radiusPx < 0.5) return src;
    const gl = r.gl;
    const w = src.width;
    const h = src.height;
    const radius = Math.min(32, Math.max(1, Math.round(radiusPx)));
    const sigma = Math.max(0.5, radiusPx / 2);
    const tmp = r.createR8Target(w, h);
    const out = r.createR8Target(w, h);
    const pass = (dst: FramebufferHandle, srcTex: TextureHandle, dirX: number, dirY: number) => {
      gl.bindFramebuffer(gl.FRAMEBUFFER, dst.fbo);
      gl.viewport(0, 0, w, h);
      gl.disable(gl.BLEND);
      gl.useProgram(prog);
      gl.uniformMatrix3fv(
        gl.getUniformLocation(prog, "u_transform"),
        false,
        new Float32Array([2, 0, 0, 0, 2, 0, -1, -1, 1]),
      );
      gl.uniform1i(gl.getUniformLocation(prog, "u_src"), 0);
      gl.uniform2f(gl.getUniformLocation(prog, "u_dir"), dirX, dirY);
      gl.uniform1i(gl.getUniformLocation(prog, "u_radius"), radius);
      gl.uniform1f(gl.getUniformLocation(prog, "u_sigma"), sigma);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, srcTex.tex);
      r.drawQuad();
    };
    pass(tmp, src.color, 1 / w, 0);
    pass(out, tmp.color, 0, 1 / h);
    r.deleteFramebuffer(tmp);
    return out;
  }

  /**
   * Composite a premultiplied-linear effect FBO (covering doc rect `rect`) OVER
   * the viewport `write`, mapping the rect into the viewport via the view
   * transform. `offset` shifts the quad by doc px (drop-shadow distance).
   *
   * The "over" is done IN-SHADER (blend DISABLED), not via fixed-function
   * blending: hardware blending into the float (RGBA16F) accumulator is silently
   * dropped on drivers without EXT_float_blend (e.g. Chrome/ANGLE on macOS),
   * which is why effects rendered nothing. We snapshot the current backdrop into
   * a scratch buffer, then the over-shader samples it (a buffer can't be both the
   * read source and the draw target) and writes `src + backdrop*(1-src.a)`.
   */
  private compositeEffectQuad(
    effect: FramebufferHandle,
    rect: Rect,
    write: FramebufferHandle,
    pixToClip: Float32Array,
    view: Float32Array,
    offset: { x: number; y: number },
    over: boolean,
  ): void {
    const r = this.renderer;
    const prog = this.effectOverProgram;
    if (!r || !prog) return;
    const gl = r.gl;

    // Snapshot the current backdrop so the over-shader can read it while drawing
    // into `write` (reusing a same-size scratch FBO across calls).
    const scratch = this.ensureEffectScratch(write.width, write.height);
    gl.bindFramebuffer(gl.FRAMEBUFFER, scratch.fbo);
    gl.viewport(0, 0, scratch.width, scratch.height);
    gl.disable(gl.BLEND);
    this.blitBackdrop(write);

    gl.bindFramebuffer(gl.FRAMEBUFFER, write.fbo);
    gl.viewport(0, 0, write.width, write.height);
    gl.disable(gl.BLEND);
    gl.useProgram(prog);
    const toDocPx = m3.multiply(
      m3.translation(rect.x + offset.x, rect.y + offset.y),
      m3.scaling(rect.width, rect.height),
    );
    const transform = m3.multiply(pixToClip, m3.multiply(view, toDocPx));
    gl.uniformMatrix3fv(gl.getUniformLocation(prog, "u_transform"), false, transform);
    gl.uniform1i(gl.getUniformLocation(prog, "u_src"), 0);
    gl.uniform1i(gl.getUniformLocation(prog, "u_backdrop"), 1);
    gl.uniform2f(gl.getUniformLocation(prog, "u_backdropSize"), write.width, write.height);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, scratch.color.tex);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, effect.color.tex);
    r.drawQuad();
    void over;
  }

  /** Lazily (re)allocate the full-screen scratch backdrop snapshot buffer. */
  private ensureEffectScratch(w: number, h: number): FramebufferHandle {
    const r = this.renderer!;
    if (this.effectScratch && this.effectScratch.width === w && this.effectScratch.height === h) {
      return this.effectScratch;
    }
    if (this.effectScratch) r.deleteFramebuffer(this.effectScratch);
    this.effectScratch = r.createColorTarget(w, h);
    return this.effectScratch;
  }

  /** Run EFFECT_FILL_FRAG into a padded RGBA color FBO (premultiplied linear). */
  private buildEffectFill(
    rect: Rect,
    cov: FramebufferHandle,
    shape: FramebufferHandle | null,
    color: { r: number; g: number; b: number },
    opacity: number,
  ): FramebufferHandle | null {
    const r = this.renderer;
    const prog = this.effectFillProgram;
    if (!r || !prog) return null;
    const gl = r.gl;
    const out = r.createColorTarget(rect.width, rect.height);
    gl.bindFramebuffer(gl.FRAMEBUFFER, out.fbo);
    gl.viewport(0, 0, rect.width, rect.height);
    gl.disable(gl.BLEND);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.useProgram(prog);
    gl.uniformMatrix3fv(
      gl.getUniformLocation(prog, "u_transform"),
      false,
      new Float32Array([2, 0, 0, 0, 2, 0, -1, -1, 1]),
    );
    gl.uniform1i(gl.getUniformLocation(prog, "u_cov"), 0);
    gl.uniform1i(gl.getUniformLocation(prog, "u_shape"), 1);
    gl.uniform1i(gl.getUniformLocation(prog, "u_useShape"), shape ? 1 : 0);
    gl.uniform3f(gl.getUniformLocation(prog, "u_color"), color.r, color.g, color.b);
    gl.uniform1f(gl.getUniformLocation(prog, "u_opacity"), opacity);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, cov.color.tex);
    if (shape) {
      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_2D, shape.color.tex);
    }
    r.drawQuad();
    return out;
  }

  /**
   * Render the BELOW-the-layer effects (drop shadow, outer glow) into `write`,
   * before the layer quad is drawn. All derive from the layer's alpha.
   */
  private renderLayerEffectsBelow(
    layer: PixelLayer,
    tex: TextureHandle,
    write: FramebufferHandle,
    _bw: number,
    _bh: number,
    view: Float32Array,
    pixToClip: Float32Array,
  ): void {
    const r = this.renderer;
    const fx = layer.effects;
    if (!r || !fx) return;

    // Drop shadow.
    const ds = fx.dropShadow;
    if (ds?.enabled) {
      const pad = Math.ceil(ds.size + Math.abs(ds.distance) + 2);
      const alpha = this.buildLayerAlpha(layer, tex, pad, ds.spread ?? 0);
      if (alpha) {
        const blurred = this.blurR8(alpha.fb, ds.size);
        const fill = this.buildEffectFill(alpha.rect, blurred, null, ds.color, ds.opacity);
        if (fill) {
          const rad = (ds.angle * Math.PI) / 180;
          const off = { x: Math.cos(rad) * ds.distance, y: -Math.sin(rad) * ds.distance };
          this.compositeEffectQuad(fill, alpha.rect, write, pixToClip, view, off, false);
          r.deleteFramebuffer(fill);
        }
        if (blurred !== alpha.fb) r.deleteFramebuffer(blurred);
        r.deleteFramebuffer(alpha.fb);
      }
    }

    // Outer glow.
    const og = fx.outerGlow;
    if (og?.enabled) {
      const pad = Math.ceil(og.size + 2);
      const alpha = this.buildLayerAlpha(layer, tex, pad, 0);
      if (alpha) {
        const blurred = this.blurR8(alpha.fb, og.size);
        const fill = this.buildEffectFill(alpha.rect, blurred, null, og.color, og.opacity);
        if (fill) {
          this.compositeEffectQuad(fill, alpha.rect, write, pixToClip, view, { x: 0, y: 0 }, false);
          r.deleteFramebuffer(fill);
        }
        if (blurred !== alpha.fb) r.deleteFramebuffer(blurred);
        r.deleteFramebuffer(alpha.fb);
      }
    }
  }

  /**
   * Render the ON-TOP-of-the-layer effects (inner shadow, color overlay,
   * stroke), after the layer quad has been drawn into `write`.
   */
  private renderLayerEffectsAbove(
    layer: PixelLayer,
    tex: TextureHandle,
    write: FramebufferHandle,
    _bw: number,
    _bh: number,
    view: Float32Array,
    pixToClip: Float32Array,
  ): void {
    const r = this.renderer;
    const fx = layer.effects;
    if (!r || !fx) return;
    const gl = r.gl;

    // Inner shadow (contained within the layer's alpha).
    const is = fx.innerShadow;
    if (is?.enabled && this.effectInnerProgram && this.effectInvertOffsetProgram) {
      const pad = Math.ceil(is.size + Math.abs(is.distance) + 2);
      const alpha = this.buildLayerAlpha(layer, tex, pad, 0);
      if (alpha) {
        // Invert + offset the alpha, blur, then multiply by the shape.
        const inv = r.createR8Target(alpha.rect.width, alpha.rect.height);
        const rad = (is.angle * Math.PI) / 180;
        const offU = { x: (Math.cos(rad) * is.distance) / alpha.rect.width, y: (-Math.sin(rad) * is.distance) / alpha.rect.height };
        gl.bindFramebuffer(gl.FRAMEBUFFER, inv.fbo);
        gl.viewport(0, 0, alpha.rect.width, alpha.rect.height);
        gl.disable(gl.BLEND);
        gl.useProgram(this.effectInvertOffsetProgram);
        gl.uniformMatrix3fv(
          gl.getUniformLocation(this.effectInvertOffsetProgram, "u_transform"),
          false,
          new Float32Array([2, 0, 0, 0, 2, 0, -1, -1, 1]),
        );
        gl.uniform1i(gl.getUniformLocation(this.effectInvertOffsetProgram, "u_src"), 0);
        gl.uniform2f(gl.getUniformLocation(this.effectInvertOffsetProgram, "u_offset"), offU.x, offU.y);
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, alpha.fb.color.tex);
        r.drawQuad();
        const blurred = this.blurR8(inv, is.size);
        // Inner fill = blurredInverted * shape, tinted.
        const out = r.createColorTarget(alpha.rect.width, alpha.rect.height);
        gl.bindFramebuffer(gl.FRAMEBUFFER, out.fbo);
        gl.viewport(0, 0, alpha.rect.width, alpha.rect.height);
        gl.disable(gl.BLEND);
        gl.clearColor(0, 0, 0, 0);
        gl.clear(gl.COLOR_BUFFER_BIT);
        gl.useProgram(this.effectInnerProgram);
        gl.uniformMatrix3fv(
          gl.getUniformLocation(this.effectInnerProgram, "u_transform"),
          false,
          new Float32Array([2, 0, 0, 0, 2, 0, -1, -1, 1]),
        );
        gl.uniform1i(gl.getUniformLocation(this.effectInnerProgram, "u_cov"), 0);
        gl.uniform1i(gl.getUniformLocation(this.effectInnerProgram, "u_shape"), 1);
        gl.uniform3f(gl.getUniformLocation(this.effectInnerProgram, "u_color"), is.color.r, is.color.g, is.color.b);
        gl.uniform1f(gl.getUniformLocation(this.effectInnerProgram, "u_opacity"), is.opacity);
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, blurred.color.tex);
        gl.activeTexture(gl.TEXTURE1);
        gl.bindTexture(gl.TEXTURE_2D, alpha.fb.color.tex);
        r.drawQuad();
        this.compositeEffectQuad(out, alpha.rect, write, pixToClip, view, { x: 0, y: 0 }, true);
        r.deleteFramebuffer(out);
        if (blurred !== inv) r.deleteFramebuffer(blurred);
        r.deleteFramebuffer(inv);
        r.deleteFramebuffer(alpha.fb);
      }
    }

    // Color overlay (clipped to the shape alpha).
    const co = fx.colorOverlay;
    if (co?.enabled) {
      const alpha = this.buildLayerAlpha(layer, tex, 0, 0);
      if (alpha) {
        const fill = this.buildEffectFill(alpha.rect, alpha.fb, alpha.fb, co.color, co.opacity);
        if (fill) {
          this.compositeEffectQuad(fill, alpha.rect, write, pixToClip, view, { x: 0, y: 0 }, true);
          r.deleteFramebuffer(fill);
        }
        r.deleteFramebuffer(alpha.fb);
      }
    }

    // Stroke (outside / inside / center band around the alpha edge).
    const st = fx.stroke;
    if (st?.enabled && st.width > 0 && this.effectStrokeProgram) {
      const pad = Math.ceil(st.width + 2);
      const alpha = this.buildLayerAlpha(layer, tex, pad, 0);
      if (alpha) {
        const out = r.createColorTarget(alpha.rect.width, alpha.rect.height);
        gl.bindFramebuffer(gl.FRAMEBUFFER, out.fbo);
        gl.viewport(0, 0, alpha.rect.width, alpha.rect.height);
        gl.disable(gl.BLEND);
        gl.clearColor(0, 0, 0, 0);
        gl.clear(gl.COLOR_BUFFER_BIT);
        gl.useProgram(this.effectStrokeProgram);
        gl.uniformMatrix3fv(
          gl.getUniformLocation(this.effectStrokeProgram, "u_transform"),
          false,
          new Float32Array([2, 0, 0, 0, 2, 0, -1, -1, 1]),
        );
        gl.uniform1i(gl.getUniformLocation(this.effectStrokeProgram, "u_shape"), 0);
        gl.uniform2f(gl.getUniformLocation(this.effectStrokeProgram, "u_texel"), 1 / alpha.rect.width, 1 / alpha.rect.height);
        gl.uniform1f(gl.getUniformLocation(this.effectStrokeProgram, "u_width"), st.width);
        gl.uniform1i(
          gl.getUniformLocation(this.effectStrokeProgram, "u_position"),
          st.position === "outside" ? 0 : st.position === "inside" ? 1 : 2,
        );
        gl.uniform3f(gl.getUniformLocation(this.effectStrokeProgram, "u_color"), st.color.r, st.color.g, st.color.b);
        gl.uniform1f(gl.getUniformLocation(this.effectStrokeProgram, "u_opacity"), st.color.a ?? 1);
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, alpha.fb.color.tex);
        r.drawQuad();
        this.compositeEffectQuad(out, alpha.rect, write, pixToClip, view, { x: 0, y: 0 }, true);
        r.deleteFramebuffer(out);
        r.deleteFramebuffer(alpha.fb);
      }
    }
  }

  /**
   * Composite the live wet stroke over `write` (the just-written layer pixel),
   * mapping the layer-local wet buffer into the viewport via the view xform.
   * Paint = premultiplied source-over of the brush color; erase = reduce alpha.
   * This is a fast preview only; the authoritative pixels are produced on commit.
   */
  private compositeBrushPreview(write: FramebufferHandle, layer: PixelLayer): void {
    const r = this.renderer;
    const wet = this.brush?.wetBuffer;
    if (!r || !wet) return;
    const gl = r.gl;
    const isErase = this.activeToolIsEraser();
    const col = this.brushColorLinear();

    gl.bindFramebuffer(gl.FRAMEBUFFER, write.fbo);
    gl.viewport(0, 0, write.width, write.height);
    gl.enable(gl.BLEND);
    if (isErase) {
      // Erase preview: multiply existing alpha+color by (1 - coverage).
      gl.blendFuncSeparate(gl.ZERO, gl.ONE_MINUS_SRC_ALPHA, gl.ZERO, gl.ONE_MINUS_SRC_ALPHA);
    } else {
      gl.blendFuncSeparate(gl.ONE, gl.ONE_MINUS_SRC_ALPHA, gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    }
    const prog = this.brushPreviewProgram();
    gl.useProgram(prog);
    const pixToClip = m3.pixelToClip(write.width, write.height);
    const viewM = m3.multiply(
      m3.translation(this.view.tx, this.view.ty),
      m3.scaling(this.view.scale, this.view.scale),
    );
    const toLayer = m3.multiply(
      m3.translation(layer.x, layer.y),
      m3.scaling(layer.width, layer.height),
    );
    const transform = m3.multiply(pixToClip, m3.multiply(viewM, toLayer));
    gl.uniformMatrix3fv(gl.getUniformLocation(prog, "u_transform"), false, transform);
    gl.uniform1i(gl.getUniformLocation(prog, "u_wet"), 0);
    gl.uniform3f(gl.getUniformLocation(prog, "u_color"), col[0], col[1], col[2]);
    gl.uniform1f(gl.getUniformLocation(prog, "u_opacity"), this.currentBrushOpacity());
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, wet.color.tex);
    r.drawQuad();
    gl.disable(gl.BLEND);
  }

  // Lazily-compiled preview program (colored wet quad, premultiplied output).
  private _previewProg: WebGLProgram | null = null;
  private brushPreviewProgram(): WebGLProgram {
    if (this._previewProg) return this._previewProg;
    const frag = /* glsl */ `#version 300 es
precision highp float;
in vec2 v_uv; out vec4 fragColor;
uniform sampler2D u_wet; uniform vec3 u_color; uniform float u_opacity;
void main() {
  float a = texture(u_wet, v_uv).r * u_opacity;
  fragColor = vec4(u_color * a, a); // premultiplied
}`;
    this._previewProg = this.renderer!.compileProgram(QUAD_VERT, frag);
    return this._previewProg;
  }

  private renderAnts(
    bw: number,
    bh: number,
    pixToClip: Float32Array,
    view: Float32Array,
  ): void {
    const r = this.renderer;
    const sel = this.selection;
    if (!r || !this.antsProgram || !sel || sel.isEmpty() || !sel.texture) return;
    const gl = r.gl;
    const { width: dw, height: dh } = sel.size;
    gl.useProgram(this.antsProgram);
    // Map the selection (document quad) into the viewport via the view xform.
    const toDocPx = m3.scaling(dw, dh);
    const transform = m3.multiply(pixToClip, m3.multiply(view, toDocPx));
    gl.uniformMatrix3fv(
      gl.getUniformLocation(this.antsProgram, "u_transform"),
      false,
      transform,
    );
    gl.uniform1i(gl.getUniformLocation(this.antsProgram, "u_selection"), 0);
    gl.uniform2f(gl.getUniformLocation(this.antsProgram, "u_selSize"), dw, dh);
    gl.uniform1f(
      gl.getUniformLocation(this.antsProgram, "u_phase"),
      (performance.now() * 0.03) % 12,
    );
    gl.disable(gl.BLEND);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, sel.texture);
    r.drawQuad();
    void bw;
    void bh;
  }

  private renderLiveMarquee(): void {
    // The in-progress marquee/lasso outline is drawn by a crisp SVG overlay in
    // the UI (CanvasHost), synced via getViewTransform()/getLiveMarquee(). The
    // committed selection's marching ants are drawn in GL (renderAnts).
  }

  /** View transform in CSS px (for UI overlays). scale here is doc->CSS px. */
  getViewTransform(): { scale: number; tx: number; ty: number } {
    return {
      scale: this.view.scale / this.dpr,
      tx: this.view.tx / this.dpr,
      ty: this.view.ty / this.dpr,
    };
  }

  // ════════════════════════════════════════════════════════
  //  RULERS / GUIDES / GRID / SNAPPING
  // ════════════════════════════════════════════════════════
  /** Add a guide (axis + doc-px position); returns its id. */
  addGuide(axis: "h" | "v", pos: number): string {
    this.guideSeq += 1;
    const id = `guide_${this.guideSeq}`;
    this.guides.push({ id, axis, pos });
    this.markDirty();
    this.emit();
    return id;
  }
  /** Remove a guide by id. */
  removeGuide(id: string): void {
    const before = this.guides.length;
    this.guides = this.guides.filter((g) => g.id !== id);
    if (this.guides.length !== before) {
      this.markDirty();
      this.emit();
    }
  }
  /** Move an existing guide to a new doc-px position. */
  moveGuide(id: string, pos: number): void {
    const g = this.guides.find((x) => x.id === id);
    if (!g) return;
    g.pos = pos;
    this.markDirty();
    this.emit();
  }
  /** All guides (copied; doc px) for the UI overlay. */
  getGuides(): Guide[] {
    return this.guides.map((g) => ({ ...g }));
  }
  /** Remove every guide. */
  clearGuides(): void {
    if (this.guides.length === 0) return;
    this.guides = [];
    this.markDirty();
    this.emit();
  }

  /**
   * Begin dragging a NEW guide off a ruler. `axis` is the guide orientation
   * (drag off the top ruler -> 'h'; off the left ruler -> 'v'). The UI feeds
   * screen points to updateGuideDrag and finalizes with endGuideDrag.
   */
  beginGuideDrag(axis: "h" | "v", screenX: number, screenY: number): void {
    const doc = this.screenToDoc(screenX, screenY);
    this.liveGuide = { id: "live", axis, pos: axis === "h" ? doc.y : doc.x };
    this.markDirty();
    this.emit();
  }
  /** Update the live guide drag from a screen point (snaps when enabled). */
  updateGuideDrag(screenX: number, screenY: number): void {
    if (!this.liveGuide) return;
    const doc = this.snapEnabled
      ? this.snapPointDoc(this.screenToDoc(screenX, screenY), 8)
      : this.screenToDoc(screenX, screenY);
    this.liveGuide.pos = this.liveGuide.axis === "h" ? doc.y : doc.x;
    this.markDirty();
    this.emit();
  }
  /**
   * Finish a live guide drag: commit it as a real guide if dropped inside the
   * document bounds, else discard (dragged back onto the ruler). Returns the new
   * guide id, or null.
   */
  endGuideDrag(): string | null {
    const lg = this.liveGuide;
    this.liveGuide = null;
    if (!lg) return null;
    const within =
      lg.axis === "h"
        ? lg.pos >= 0 && lg.pos <= this.doc.height
        : lg.pos >= 0 && lg.pos <= this.doc.width;
    let id: string | null = null;
    if (within) id = this.addGuide(lg.axis, lg.pos);
    this.markDirty();
    this.emit();
    return id;
  }
  /** The live guide being dragged off a ruler (doc px), or null. */
  getLiveGuide(): Guide | null {
    return this.liveGuide ? { ...this.liveGuide } : null;
  }

  // ── grid ────────────────────────────────────────────────
  setGridVisible(visible: boolean): void {
    if (this.grid.visible === visible) return;
    this.grid = { ...this.grid, visible };
    this.markDirty();
    this.emit();
  }
  setGridSize(size: number, subdivisions?: number): void {
    this.grid = {
      ...this.grid,
      size: Math.max(1, size),
      subdivisions: Math.max(1, Math.round(subdivisions ?? this.grid.subdivisions)),
    };
    this.markDirty();
    this.emit();
  }
  /** Current grid config (copied). */
  getGrid(): GridState {
    return { ...this.grid };
  }

  // ── rulers + snapping toggles ───────────────────────────
  setRulersVisible(visible: boolean): void {
    if (this.rulersVisible === visible) return;
    this.rulersVisible = visible;
    this.markDirty();
    this.emit();
  }
  getRulersVisible(): boolean {
    return this.rulersVisible;
  }
  setSnapEnabled(enabled: boolean): void {
    if (this.snapEnabled === enabled) return;
    this.snapEnabled = enabled;
    this.emit();
  }
  getSnapEnabled(): boolean {
    return this.snapEnabled;
  }

  /**
   * Snap a document-space point to nearby guides, grid lines (when the grid is
   * on), the canvas bounds (0,0,w,h) and the canvas center/halves. Each axis
   * snaps independently to the closest candidate within `thresholdScreenPx`
   * (converted to doc px via the view scale). Returns the (possibly snapped)
   * point. A no-op when snapping is disabled.
   */
  snapPointDoc(
    p: { x: number; y: number },
    thresholdScreenPx = 8,
  ): { x: number; y: number } {
    if (!this.snapEnabled) return { x: p.x, y: p.y };
    const thr = thresholdScreenPx / Math.max(1e-4, this.view.scale); // doc px
    const w = this.doc.width;
    const h = this.doc.height;

    // Candidate snap lines per axis.
    const xs: number[] = [0, w, w / 2];
    const ys: number[] = [0, h, h / 2];
    for (const g of this.guides) {
      if (g.axis === "v") xs.push(g.pos);
      else ys.push(g.pos);
    }
    if (this.grid.visible) {
      const step = this.grid.size / this.grid.subdivisions;
      if (step > 0.5) {
        const gx = Math.round(p.x / step) * step;
        const gy = Math.round(p.y / step) * step;
        xs.push(gx);
        ys.push(gy);
      }
    }

    const best = (val: number, cands: number[]): number => {
      let out = val;
      let bestD = thr;
      for (const c of cands) {
        const d = Math.abs(val - c);
        if (d < bestD) {
          bestD = d;
          out = c;
        }
      }
      return out;
    };
    return { x: best(p.x, xs), y: best(p.y, ys) };
  }

  /**
   * Snap a moving box (top-left `x,y` of size `w,h`) so that ANY of its left /
   * center / right edges (and top / mid / bottom) lands on a snap line, choosing
   * the smallest correction per axis. Returns the snapped top-left. Uses the
   * same candidate lines as snapPointDoc.
   */
  private snapMovedBox(
    x: number,
    y: number,
    w: number,
    h: number,
    thresholdScreenPx: number,
  ): { x: number; y: number } {
    const thr = thresholdScreenPx / Math.max(1e-4, this.view.scale);
    const dw = this.doc.width;
    const dh = this.doc.height;
    const xs: number[] = [0, dw, dw / 2];
    const ys: number[] = [0, dh, dh / 2];
    for (const g of this.guides) {
      if (g.axis === "v") xs.push(g.pos);
      else ys.push(g.pos);
    }
    if (this.grid.visible) {
      const step = this.grid.size / this.grid.subdivisions;
      if (step > 0.5) {
        // Nearest grid lines to each of the box's three probe positions.
        for (const probe of [x, x + w / 2, x + w]) xs.push(Math.round(probe / step) * step);
        for (const probe of [y, y + h / 2, y + h]) ys.push(Math.round(probe / step) * step);
      }
    }
    // For each axis, the three probes are at offsets 0, w/2, w from the origin.
    const snapAxis = (origin: number, size: number, cands: number[]): number => {
      let bestCorr = 0;
      let bestD = thr;
      for (const off of [0, size / 2, size]) {
        const probe = origin + off;
        for (const c of cands) {
          const d = Math.abs(probe - c);
          if (d < bestD) {
            bestD = d;
            bestCorr = c - probe;
          }
        }
      }
      return origin + bestCorr;
    };
    return { x: snapAxis(x, w, xs), y: snapAxis(y, h, ys) };
  }

  /** Active marquee rect in document px while dragging, or null. */
  getLiveMarquee(): { x0: number; y0: number; x1: number; y1: number; shape: "rect" | "ellipse" } | null {
    if (!this.liveMarquee || this.gesture.kind !== "marquee") return null;
    return { ...this.liveMarquee, shape: this.gesture.shape };
  }

  /** Active lasso polygon in document px while dragging, or null. */
  getLiveLasso(): number[] | null {
    return this.gesture.kind === "lasso" ? this.gesture.pts : null;
  }

  /** Active gradient drag line in document px (from->to), or null. */
  getLiveGradient(): { from: { x: number; y: number }; to: { x: number; y: number } } | null {
    return this.gesture.kind === "gradient" ? this.liveGradient : null;
  }

  // ── tool helpers ────────────────────────────────────────
  private activeTool(): ToolId {
    return toolStore.get().active;
  }
  private activeToolIsEraser(): boolean {
    return this.activeTool() === "eraser";
  }
  private currentBrushOpacity(): number {
    return toolStore.get().brush.opacity;
  }
  private brushColorLinear(): [number, number, number] {
    // Brush paints the FOREGROUND color (sRGB straight) decoded to linear light,
    // matching the linear compositing pipeline.
    const fg = toolStore.get().foreground;
    return [srgbToLinearScalar(fg.r), srgbToLinearScalar(fg.g), srgbToLinearScalar(fg.b)];
  }

  // ── pointer + key handling ──────────────────────────────
  private handleWheel(e: WheelEvent): void {
    e.preventDefault();
    const rect = (this.canvas as HTMLCanvasElement).getBoundingClientRect();
    const factor = Math.exp(-e.deltaY * 0.0015);
    this.zoomAt(factor, e.clientX - rect.left, e.clientY - rect.top);
  }

  private localPoint(e: PointerEvent): { x: number; y: number } {
    const rect = (this.canvas as HTMLCanvasElement).getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  }

  private handlePointerDown(e: PointerEvent): void {
    const canvas = this.canvas;
    if (!canvas) return;
    canvas.setPointerCapture(e.pointerId);
    const local = this.localPoint(e);
    this.lastPointer = { x: e.clientX, y: e.clientY };
    const tool = this.activeTool();

    // Hand tool or spacebar = pan, regardless of selected tool.
    if (tool === "hand" || this.spaceHeld || e.button === 1) {
      this.gesture = { kind: "pan" };
      return;
    }

    const doc = this.screenToDoc(local.x, local.y);
    const activeId = this.doc.getActiveLayerId();

    // Double-click a text layer opens it for editing — the Photoshop affordance
    // the type editor relies on. `e.detail >= 2` is the native dblclick count.
    // Scoped to the Move/Type tools so it can't hijack a double-click that ends
    // a lasso, finishes a marquee, or lands a brush dab. Skip when already
    // editing this very layer.
    if (e.detail >= 2 && (tool === "move" || tool === "text")) {
      const hitText = this.hitTestTopTextLayer(doc.x, doc.y);
      if (hitText && !(this.textEditing && this.textEditing.layerId === hitText)) {
        this.beginEditText(hitText);
        this.gesture = { kind: "none" };
        return;
      }
    }

    // Free-transform: route to the live session if one is active.
    if (tool === "transform" && this.transformSession) {
      const hit = this.hitTestTransform(local.x, local.y);
      if (hit) {
        this.gesture = {
          kind: "transform",
          mode: hit.mode,
          handle: hit.handle,
          startDoc: doc,
          start: { ...this.transformSession.base },
        };
      } else {
        // Click outside the box commits the transform (Photoshop behaviour).
        this.commitTransform();
        this.gesture = { kind: "none" };
      }
      return;
    }

    // Crop: route drags to the live crop rect.
    if (tool === "crop") {
      if (!this.cropSession) this.beginCrop();
      const mode = this.hitTestCrop(local.x, local.y);
      const startRect = mode === "new"
        ? { x: doc.x, y: doc.y, width: 0, height: 0 }
        : { ...this.cropSession!.rect };
      if (mode === "new") this.cropSession!.rect = startRect;
      this.gesture = { kind: "crop", mode, startDoc: doc, startRect };
      this.markDirty();
      return;
    }

    // Type tool: click creates a text layer (or opens an existing one if hit).
    if (tool === "text") {
      const hitText = this.hitTestTopTextLayer(doc.x, doc.y);
      if (hitText) this.beginEditText(hitText);
      else this.addTextLayer(doc.x, doc.y, "");
      this.gesture = { kind: "none" };
      return;
    }

    // Shape tool: drag to define the shape rect / line.
    if (tool === "shape") {
      this.gesture = { kind: "shape", from: { x: doc.x, y: doc.y }, to: { x: doc.x, y: doc.y } };
      this.liveShape = { kind: toolStore.get().shape.kind, from: { x: doc.x, y: doc.y }, to: { x: doc.x, y: doc.y } };
      this.markDirty();
      return;
    }

    // Pen tool: build a vector path. Clicking the first anchor closes the
    // subpath; otherwise a click adds a corner anchor (a subsequent drag pulls
    // its out handle, turning it into a smooth anchor).
    if (tool === "pen") {
      this.penPointerDown(doc, e);
      return;
    }

    if (tool === "move" && activeId) {
      const layer = this.doc.getLayer(activeId);
      if (layer && isPixelLayer(layer)) {
        this.gesture = {
          kind: "move",
          startX: doc.x,
          startY: doc.y,
          origX: layer.x,
          origY: layer.y,
          layerId: activeId,
        };
      }
      return;
    }

    // Retouch brushes (clone/heal/dodge/burn/smudge/blur/sharpen) operate on the
    // active raster layer's pixels. Intercept BEFORE the generic paint branch
    // (isPaintTool now includes them). Alt/Option-click on clone/heal sets the
    // clone source instead of starting a stroke.
    if (isRetouchTool(tool) && activeId) {
      if ((tool === "clone" || tool === "heal") && e.altKey) {
        const layer = this.doc.getLayer(activeId);
        if (layer && layer.kind === "raster") {
          this.retouch?.setCloneSource(doc.x - layer.x, doc.y - layer.y);
          this.markDirty();
          this.emit();
        }
        this.gesture = { kind: "none" };
        return;
      }
      this.beginRetouch(activeId, tool, doc, e);
      return;
    }

    if (isPaintTool(tool) && activeId) {
      this.beginPaint(activeId, doc, e);
      return;
    }

    if (tool === "magic-wand") {
      const mw = toolStore.get().magicWand;
      this.magicWandSelect(doc.x, doc.y, {
        tolerance: mw.tolerance,
        contiguous: mw.contiguous,
        sampleAllLayers: mw.sampleAllLayers,
        op: selectionOpFromEvent(e),
      });
      this.gesture = { kind: "none" };
      return;
    }

    if (tool === "marquee-rect" || tool === "marquee-ellipse") {
      this.gesture = {
        kind: "marquee",
        shape: tool === "marquee-ellipse" ? "ellipse" : "rect",
        startDoc: doc,
        op: selectionOpFromEvent(e),
      };
      this.liveMarquee = { x0: doc.x, y0: doc.y, x1: doc.x, y1: doc.y };
      return;
    }

    if (tool === "lasso") {
      this.gesture = { kind: "lasso", pts: [doc.x, doc.y], op: selectionOpFromEvent(e) };
      return;
    }

    if (tool === "eyedropper") {
      const c = this.sampleColorAt(doc.x, doc.y);
      if (c.a > 0) toolStore.setForeground({ r: c.r, g: c.g, b: c.b, a: 1 });
      this.gesture = { kind: "none" };
      return;
    }

    if (tool === "bucket" && activeId) {
      // v1 flood: fill the selected region (or whole layer) with foreground.
      this.fillSelection(toolStore.get().foreground, activeId);
      this.gesture = { kind: "none" };
      return;
    }

    if (tool === "gradient" && activeId) {
      this.gesture = {
        kind: "gradient",
        layerId: activeId,
        from: { x: doc.x, y: doc.y },
        to: { x: doc.x, y: doc.y },
      };
      this.liveGradient = { from: { x: doc.x, y: doc.y }, to: { x: doc.x, y: doc.y } };
      return;
    }

    // Fallback: pan.
    this.gesture = { kind: "pan" };
  }

  private handlePointerMove(e: PointerEvent): void {
    const g = this.gesture;
    if (g.kind === "none") return;
    const local = this.localPoint(e);

    if (g.kind === "pan") {
      const dx = (e.clientX - this.lastPointer.x) * this.dpr;
      const dy = (e.clientY - this.lastPointer.y) * this.dpr;
      this.lastPointer = { x: e.clientX, y: e.clientY };
      this.pan(dx, dy);
      return;
    }

    if (g.kind === "move") {
      const doc = this.screenToDoc(local.x, local.y);
      let nx = g.origX + (doc.x - g.startX);
      let ny = g.origY + (doc.y - g.startY);
      // Snap the moved layer's top-left corner (and, via the snapped delta, its
      // edges/center read through the same lines) to guides/grid/bounds/center.
      if (this.snapEnabled) {
        const layer = this.doc.getLayer(g.layerId);
        const lw = layer && isPixelLayer(layer) ? layer.width : 0;
        const lh = layer && isPixelLayer(layer) ? layer.height : 0;
        const snapped = this.snapMovedBox(nx, ny, lw, lh, 8);
        nx = snapped.x;
        ny = snapped.y;
      }
      this.doc.setPosition(g.layerId, Math.round(nx), Math.round(ny));
      return;
    }

    if (g.kind === "transform" && this.transformSession) {
      const doc = this.screenToDoc(local.x, local.y);
      this.updateTransformDrag(g, doc, e.shiftKey);
      this.markDirty();
      this.emit();
      return;
    }

    if (g.kind === "crop") {
      const doc = this.screenToDoc(local.x, local.y);
      this.updateCropDrag(g, doc);
      this.markDirty();
      this.emit();
      return;
    }

    if (g.kind === "shape") {
      let doc = this.screenToDoc(local.x, local.y);
      // Snap the moving endpoint to guides/grid/bounds/center (Shift still
      // constrains off the snapped point below).
      if (this.snapEnabled && !e.shiftKey) doc = this.snapPointDoc(doc, 8);
      let tx = doc.x;
      let ty = doc.y;
      const kind = this.liveShape?.kind ?? toolStore.get().shape.kind;
      if (e.shiftKey) {
        const dx = doc.x - g.from.x;
        const dy = doc.y - g.from.y;
        if (kind === "line") {
          // 45° snaps.
          const ang = Math.round(Math.atan2(dy, dx) / (Math.PI / 4)) * (Math.PI / 4);
          const len = Math.hypot(dx, dy);
          tx = g.from.x + Math.cos(ang) * len;
          ty = g.from.y + Math.sin(ang) * len;
        } else {
          // square / circle: equal extent, preserving drag direction.
          const s = Math.max(Math.abs(dx), Math.abs(dy));
          tx = g.from.x + Math.sign(dx || 1) * s;
          ty = g.from.y + Math.sign(dy || 1) * s;
        }
      }
      g.to = { x: tx, y: ty };
      this.liveShape = { kind, from: g.from, to: g.to };
      this.markDirty();
      return;
    }

    if (g.kind === "pen") {
      // Drag the just-placed anchor's out handle (mirrors to the in handle), so
      // a click-drag produces a smooth anchor.
      const doc = this.screenToDoc(local.x, local.y);
      this.paths.setLastAnchorOut(doc.x, doc.y, true);
      this.markDirty();
      this.emit();
      return;
    }

    if (g.kind === "paint") {
      // Use coalesced events for smooth high-rate strokes.
      const events = e.getCoalescedEvents?.() ?? [e];
      for (const ce of events) {
        const cl = this.localPoint(ce);
        const doc = this.screenToDoc(cl.x, cl.y);
        const layer = this.doc.getLayer(g.layerId);
        if (!layer) break;
        // Adjustment/group-mask painting is full-doc (origin 0,0); pixel layers use x/y.
        const lx0 = isPixelLayer(layer) ? layer.x : 0;
        const ly0 = isPixelLayer(layer) ? layer.y : 0;
        const lx = doc.x - lx0;
        const ly = doc.y - ly0;
        this.brush?.stampTo(lx, ly, ce.pressure);
      }
      this.markDirty();
      return;
    }

    if (g.kind === "retouch") {
      const events = e.getCoalescedEvents?.() ?? [e];
      for (const ce of events) {
        const cl = this.localPoint(ce);
        const doc = this.screenToDoc(cl.x, cl.y);
        const layer = this.doc.getLayer(g.layerId);
        if (!layer || layer.kind !== "raster") break;
        this.retouch?.stampTo(doc.x - layer.x, doc.y - layer.y, ce.pressure);
      }
      this.markDirty();
      return;
    }

    if (g.kind === "gradient") {
      const doc = this.screenToDoc(local.x, local.y);
      // Shift constrains to 45° increments (classic gradient behaviour).
      let tx = doc.x;
      let ty = doc.y;
      if (e.shiftKey) {
        const dx = doc.x - g.from.x;
        const dy = doc.y - g.from.y;
        const ang = Math.round(Math.atan2(dy, dx) / (Math.PI / 4)) * (Math.PI / 4);
        const len = Math.hypot(dx, dy);
        tx = g.from.x + Math.cos(ang) * len;
        ty = g.from.y + Math.sin(ang) * len;
      }
      g.to = { x: tx, y: ty };
      this.liveGradient = { from: g.from, to: g.to };
      this.markDirty();
      return;
    }

    if (g.kind === "marquee" && this.liveMarquee) {
      let doc = this.screenToDoc(local.x, local.y);
      // Snap the dragged (moving) corner; the start corner stays put.
      if (this.snapEnabled) doc = this.snapPointDoc(doc, 8);
      this.liveMarquee = {
        x0: g.startDoc.x,
        y0: g.startDoc.y,
        x1: doc.x,
        y1: doc.y,
      };
      this.markDirty();
      return;
    }

    if (g.kind === "lasso") {
      const doc = this.screenToDoc(local.x, local.y);
      g.pts.push(doc.x, doc.y);
      this.markDirty();
      return;
    }
  }

  private handlePointerUp(_e: PointerEvent): void {
    const g = this.gesture;
    this.gesture = { kind: "none" };

    if (g.kind === "move") {
      const layer = this.doc.getLayer(g.layerId);
      if (layer && isPixelLayer(layer) && (layer.x !== g.origX || layer.y !== g.origY)) {
        const id = g.layerId;
        const from = { x: g.origX, y: g.origY };
        const to = { x: layer.x, y: layer.y };
        this.history.push(
          paramCommand(
            "Move layer",
            () => this.doc.setPosition(id, to.x, to.y),
            () => this.doc.setPosition(id, from.x, from.y),
          ),
        );
      }
      return;
    }

    if (g.kind === "paint") {
      this.commitPaint(g.layerId, g.onMask);
      return;
    }

    if (g.kind === "retouch") {
      this.commitRetouch(g.layerId, g.mode);
      return;
    }

    if (g.kind === "gradient") {
      this.liveGradient = null;
      const grad = toolStore.get().gradient;
      // Zero-length drag = no gradient.
      if (Math.hypot(g.to.x - g.from.x, g.to.y - g.from.y) >= 1) {
        // Pass the tool's multi-stop ramp (reversed if requested) through.
        const stops = grad.reverse
          ? grad.stops.map((s) => ({ pos: 1 - s.pos, color: { ...s.color } }))
          : grad.stops.map((s) => ({ pos: s.pos, color: { ...s.color } }));
        this.applyGradientFill(g.layerId, {
          type: grad.type,
          from: g.from,
          to: g.to,
          stops,
        });
      }
      this.markDirty();
      return;
    }

    if (g.kind === "marquee" && this.selection && this.liveMarquee) {
      const m = this.liveMarquee;
      this.liveMarquee = null;
      if (Math.abs(m.x1 - m.x0) >= 1 && Math.abs(m.y1 - m.y0) >= 1) {
        this.selection.commitShape(g.shape, m, g.op, toolStore.get().feather);
        this.emit();
      }
      this.markDirty();
      return;
    }

    if (g.kind === "lasso" && this.selection) {
      this.selection.commitPolygon(g.pts, g.op, toolStore.get().feather);
      this.emit();
      this.markDirty();
      return;
    }

    // Transform / crop drags persist in their session (no commit on pointer-up;
    // Enter commits, Esc cancels). Just settle the render.
    if (g.kind === "transform" || g.kind === "crop") {
      this.markDirty();
      this.emit();
      return;
    }

    if (g.kind === "shape") {
      const live = this.liveShape;
      this.liveShape = null;
      if (live) this.commitShape(live.kind, live.from, live.to);
      this.markDirty();
      return;
    }

    if (g.kind === "pen") {
      // Anchor (+ optional handle drag) already applied during the gesture.
      this.markDirty();
      this.emit();
      return;
    }
  }

  private handleKeyDown(e: KeyboardEvent): void {
    const meta = e.metaKey || e.ctrlKey;

    // Enter commits / Esc cancels an active transform or crop session. When a
    // text editor overlay is focused, let the UI handle the keys (it'll call
    // endEditText / commitTextLayer) — ignore here.
    if (!this.textEditing && (this.transformSession || this.cropSession)) {
      if (e.key === "Enter") {
        e.preventDefault();
        if (this.transformSession) this.commitTransform();
        else if (this.cropSession) this.commitCrop();
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        if (this.transformSession) this.cancelTransform();
        else if (this.cropSession) this.cancelCrop();
        return;
      }
    }

    // Pen tool: Enter/Esc finish (commit) the in-progress path. Enter keeps the
    // committed path active (so it can be filled/stroked); Esc discards it.
    if (!this.textEditing && this.activeTool() === "pen" && this.paths.isDrawing) {
      if (e.key === "Enter") {
        e.preventDefault();
        this.paths.finishLive();
        this.markDirty();
        this.emit();
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        this.paths.clearLive();
        this.markDirty();
        this.emit();
        return;
      }
    }

    if (e.code === "Space") {
      this.spaceHeld = true;
      return;
    }
    if (meta && (e.key === "z" || e.key === "Z")) {
      e.preventDefault();
      if (e.shiftKey) this.redo();
      else this.undo();
      return;
    }
    if (meta && (e.key === "y" || e.key === "Y")) {
      e.preventDefault();
      this.redo();
      return;
    }
    if (meta && (e.key === "a" || e.key === "A")) {
      e.preventDefault();
      this.selectAll();
      return;
    }
    if (meta && (e.key === "d" || e.key === "D")) {
      e.preventDefault();
      this.clearSelection();
      return;
    }
  }
  private handleKeyUp(e: KeyboardEvent): void {
    if (e.code === "Space") this.spaceHeld = false;
  }

  // ── paint stroke lifecycle ──────────────────────────────
  private beginPaint(
    layerId: LayerId,
    doc: { x: number; y: number },
    e: PointerEvent,
  ): void {
    const layer = this.doc.getLayer(layerId);
    const brush = this.brush;
    const sel = this.selection;
    if (!layer || !brush) return;
    // Paint on the mask when the layer has an enabled mask; else on pixels.
    const onMask = !!layer.mask?.enabled;
    // Adjustment layers carry no pixels — only paintable target is their mask.
    if (layer.kind === "adjustment" && !onMask) return;
    // Geometry: raster layers use their footprint; adjustment masks are full-doc.
    const lx0 = layer.kind === "raster" ? layer.x : 0;
    const ly0 = layer.kind === "raster" ? layer.y : 0;
    const target = {
      width: onMask ? layer.mask!.width : (layer as RasterLayer).width,
      height: onMask ? layer.mask!.height : (layer as RasterLayer).height,
      x: lx0,
      y: ly0,
    };
    const selTex = sel && !sel.isEmpty() ? sel.texture : null;
    brush.begin(target, toolStore.get().brush, selTex, sel ? sel.size : { width: this.doc.width, height: this.doc.height });
    this.gesture = { kind: "paint", layerId, onMask };
    const lx = doc.x - lx0;
    const ly = doc.y - ly0;
    brush.stampTo(lx, ly, e.pressure);
    this.markDirty();
  }

  /** Flatten the wet stroke into the layer (or mask) as ONE undo step. */
  private commitPaint(layerId: LayerId, onMask: boolean): void {
    const r = this.renderer;
    const brush = this.brush;
    const layer = this.doc.getLayer(layerId);
    const wet = brush?.wetBuffer;
    if (!r || !brush || !layer || !wet) {
      brush?.end();
      return;
    }
    const isErase = this.activeToolIsEraser();
    if (onMask && layer.mask) {
      this.flattenStrokeToMask(layer, wet, isErase);
    } else if (layer.kind === "raster") {
      this.flattenStrokeToLayer(layer, wet, isErase);
    }
    brush.end();
    this.markDirty();
  }

  // ── retouch stroke lifecycle (clone/heal/dodge/burn/smudge/blur/sharpen) ──
  /** Map a ToolId to a RetouchEngine mode. */
  private retouchModeFor(tool: ToolId): RetouchMode | null {
    switch (tool) {
      case "clone": return "clone";
      case "heal": return "heal";
      case "dodge": return "dodge";
      case "burn": return "burn";
      case "smudge": return "smudge";
      case "blur-brush": return "blur";
      case "sharpen-brush": return "sharpen";
      default: return null;
    }
  }

  /**
   * Begin a retouch stroke on a raster layer. Seeds the working buffer from the
   * layer's current texture, then stamps the first dab. Clone/heal need a source
   * point (set via Alt-click) — without one, the stroke is a no-op (the dab is
   * skipped) until a source exists.
   */
  private beginRetouch(
    layerId: LayerId,
    tool: ToolId,
    doc: { x: number; y: number },
    e: PointerEvent,
  ): void {
    const layer = this.doc.getLayer(layerId);
    const retouch = this.retouch;
    const sel = this.selection;
    const mode = this.retouchModeFor(tool);
    if (!layer || layer.kind !== "raster" || !retouch || !mode) return;
    const tex = this.resolveTexture(layerId);
    if (!tex) return;

    const ts = toolStore.get();
    let params: RetouchParams;
    let aligned = true;
    if (mode === "clone" || mode === "heal") {
      params = { size: ts.clone.size, hardness: ts.clone.hardness, amount: ts.clone.opacity };
      aligned = ts.clone.aligned;
    } else if (mode === "dodge" || mode === "burn") {
      params = {
        size: ts.dodgeBurn.size,
        hardness: ts.dodgeBurn.hardness,
        amount: ts.dodgeBurn.exposure,
        range: ts.dodgeBurn.range,
      };
    } else if (mode === "smudge") {
      params = { size: ts.smudge.size, hardness: ts.smudge.hardness, amount: ts.smudge.strength };
    } else {
      params = { size: ts.focus.size, hardness: ts.focus.hardness, amount: ts.focus.strength };
    }

    const selTex = sel && !sel.isEmpty() ? sel.texture : null;
    const docSize = sel ? sel.size : { width: this.doc.width, height: this.doc.height };
    retouch.begin(
      mode,
      { width: layer.width, height: layer.height, x: layer.x, y: layer.y },
      params,
      aligned,
      selTex,
      docSize,
    );
    retouch.seed(tex);
    this.gesture = { kind: "retouch", layerId, mode };
    retouch.stampTo(doc.x - layer.x, doc.y - layer.y, e.pressure);
    this.markDirty();
  }

  /** Read the retouch working buffer back into a new layer source; one undo step. */
  private commitRetouch(layerId: LayerId, mode: RetouchMode): void {
    const r = this.renderer;
    const retouch = this.retouch;
    const layer = this.doc.getLayer(layerId);
    if (!r || !retouch || !layer || layer.kind !== "raster") {
      retouch?.end();
      this.markDirty();
      return;
    }
    const work = retouch.workTexture;
    // Nothing changed (e.g. clone with no source point) — discard without a step.
    if (!work || !retouch.hasEdited()) {
      retouch.end();
      this.markDirty();
      return;
    }
    const gl = r.gl;
    const target = r.createRGBA8Target(layer.width, layer.height);
    gl.bindFramebuffer(gl.FRAMEBUFFER, target.fbo);
    gl.viewport(0, 0, layer.width, layer.height);
    gl.disable(gl.BLEND);
    const prog = this.copyProgram!;
    gl.useProgram(prog);
    gl.uniformMatrix3fv(
      gl.getUniformLocation(prog, "u_transform"),
      false,
      new Float32Array([2, 0, 0, 0, 2, 0, -1, -1, 1]),
    );
    gl.uniform1i(gl.getUniformLocation(prog, "u_src"), 0);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, work.tex);
    r.drawQuad();
    const rawPx = r.readPixels(target, 0, 0, layer.width, layer.height);
    r.deleteFramebuffer(target);
    retouch.end();

    const newSource = rawToImageData(rawPx, layer.width, layer.height);
    const prevSource = layer.source;
    const id = layer.id;
    const apply = () => {
      this.doc.replaceSource(id, newSource);
      this.textures.delete(id);
    };
    const revert = () => {
      this.doc.replaceSource(id, prevSource);
      this.textures.delete(id);
    };
    apply();
    this.history.push({
      label: RETOUCH_LABELS[mode],
      bytes: layer.width * layer.height * 4,
      undo: revert,
      redo: apply,
    });
    this.markDirty();
  }

  /** Set the clone source in document px (UI cursor / Alt-click flow). */
  setCloneSource(docX: number, docY: number): void {
    const id = this.doc.getActiveLayerId();
    if (!id) return;
    const layer = this.doc.getLayer(id);
    if (!layer || layer.kind !== "raster") return;
    this.retouch?.setCloneSource(docX - layer.x, docY - layer.y);
    this.markDirty();
    this.emit();
  }

  /** The current clone source in DOCUMENT px (for a UI cursor hint), or null. */
  getCloneSource(): { x: number; y: number } | null {
    const id = this.doc.getActiveLayerId();
    const src = this.retouch?.getCloneSource();
    if (!src || !id) return null;
    const layer = this.doc.getLayer(id);
    if (!layer || layer.kind !== "raster") return null;
    return { x: src.x + layer.x, y: src.y + layer.y };
  }

  // ════════════════════════════════════════════════════════
  //  MAGIC WAND / SELECT BY COLOR
  // ════════════════════════════════════════════════════════
  /**
   * Build a selection from a color match at a document seed point. Reads the
   * source pixels (active raster layer, or the flattened composite when
   * `sampleAllLayers`) via RGBA8 readback, then either flood-fills contiguously
   * from the seed or matches globally by color distance vs the seed color. The
   * resulting coverage is anti-aliased one px at the edge and combined into the
   * live selection per the boolean `op`. No undo (selections aren't on history,
   * matching the existing marquee/lasso behaviour).
   */
  magicWandSelect(
    docX: number,
    docY: number,
    opts: {
      tolerance: number;
      contiguous: boolean;
      sampleAllLayers: boolean;
      op?: SelectionOp;
    },
  ): void {
    const r = this.renderer;
    const sel = this.selection;
    if (!r || !sel) return;
    const dw = this.doc.width;
    const dh = this.doc.height;
    const sx = Math.round(docX);
    const sy = Math.round(docY);
    if (sx < 0 || sy < 0 || sx >= dw || sy >= dh) return;

    // Acquire doc-sized, top-down RGBA8 source pixels.
    const px = this.readSourcePixels(opts.sampleAllLayers);
    if (!px) return;

    const seedIdx = (sy * dw + sx) * 4;
    const sr = px[seedIdx] ?? 0;
    const sg = px[seedIdx + 1] ?? 0;
    const sb = px[seedIdx + 2] ?? 0;
    const sa = px[seedIdx + 3] ?? 0;
    // Tolerance is a 0..255 per-channel-ish threshold; compare squared euclidean
    // distance against tol^2 * channels for a smooth round region.
    const tol = Math.max(0, opts.tolerance);
    const tol2 = tol * tol * 3; // RGB; alpha handled separately below.

    const mask = new Uint8Array(dw * dh);
    const inRange = (i: number): boolean => {
      const o = i * 4;
      const dr = (px[o] ?? 0) - sr;
      const dg = (px[o + 1] ?? 0) - sg;
      const db = (px[o + 2] ?? 0) - sb;
      const da = (px[o + 3] ?? 0) - sa;
      // Distance includes alpha so transparent vs opaque regions separate.
      return dr * dr + dg * dg + db * db + da * da <= tol2 + tol * tol;
    };

    if (opts.contiguous) {
      // 4-connected flood fill from the seed (iterative stack).
      const stack: number[] = [sy * dw + sx];
      const seen = new Uint8Array(dw * dh);
      seen[sy * dw + sx] = 1;
      while (stack.length) {
        const i = stack.pop()!;
        if (!inRange(i)) continue;
        mask[i] = 255;
        const x = i % dw;
        const y = (i - x) / dw;
        if (x > 0 && !seen[i - 1]) { seen[i - 1] = 1; stack.push(i - 1); }
        if (x < dw - 1 && !seen[i + 1]) { seen[i + 1] = 1; stack.push(i + 1); }
        if (y > 0 && !seen[i - dw]) { seen[i - dw] = 1; stack.push(i - dw); }
        if (y < dh - 1 && !seen[i + dw]) { seen[i + dw] = 1; stack.push(i + dw); }
      }
    } else {
      for (let i = 0; i < dw * dh; i++) if (inRange(i)) mask[i] = 255;
    }

    // Light edge antialias: average each border texel with its 4-neighbourhood
    // so the marching-ants contour and feathered edits look less jagged.
    antialiasMaskEdge(mask, dw, dh);

    const op: SelectionOp = opts.op ?? "replace";
    sel.combineFromBuffer(mask, op, toolStore.get().feather);
    this.markDirty();
    this.emit();
  }

  /**
   * Doc-sized, top-down RGBA8 source pixels for the magic wand. When
   * `allLayers`, this is the flattened composite (un-premultiplied, sRGB); else
   * the active raster layer rendered into the document frame (out-of-footprint
   * pixels are transparent). Returns null when nothing is samplable.
   */
  private readSourcePixels(allLayers: boolean): Uint8ClampedArray | null {
    const r = this.renderer;
    if (!r) return null;
    const dw = this.doc.width;
    const dh = this.doc.height;

    if (allLayers) {
      const fb = this.renderDocumentComposite();
      if (!fb) return null;
      const raw = r.readPixels(fb, 0, 0, dw, dh);
      r.deleteFramebuffer(fb);
      // renderDocumentComposite returns premultiplied display-sRGB? No — it
      // blits the LINEAR accumulator into RGBA8 verbatim (premultiplied linear
      // bytes). Un-premultiply + encode to sRGB, and flip rows to top-down.
      const out = new Uint8ClampedArray(dw * dh * 4);
      for (let y = 0; y < dh; y++) {
        const srcRow = (dh - 1 - y) * dw * 4;
        const dstRow = y * dw * 4;
        for (let x = 0; x < dw * 4; x += 4) {
          const a = (raw[srcRow + x + 3] ?? 0) / 255;
          const inv = a > 1e-4 ? 1 / a : 0;
          for (let ch = 0; ch < 3; ch++) {
            const lin = ((raw[srcRow + x + ch] ?? 0) / 255) * inv;
            out[dstRow + x + ch] = Math.round(linearToSrgb(lin) * 255);
          }
          out[dstRow + x + 3] = raw[srcRow + x + 3] ?? 0;
        }
      }
      return out;
    }

    // Active raster layer only — render it into a doc-frame RGBA8 target.
    const id = this.doc.getActiveLayerId();
    if (!id) return null;
    const layer = this.doc.getLayer(id);
    if (!layer || layer.kind !== "raster") return null;
    const tex = this.resolveTexture(id);
    const blend = this.normalBlendProgram;
    if (!tex || !blend) return null;
    const gl = r.gl;
    const target = r.createRGBA8Target(dw, dh);
    gl.bindFramebuffer(gl.FRAMEBUFFER, target.fbo);
    gl.viewport(0, 0, dw, dh);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.enable(gl.BLEND);
    gl.blendFuncSeparate(gl.ONE, gl.ONE_MINUS_SRC_ALPHA, gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    gl.useProgram(blend);
    const pixToClip = m3.pixelToClip(dw, dh);
    const toDocPx = m3.multiply(
      m3.translation(layer.x, layer.y),
      m3.scaling(layer.width, layer.height),
    );
    const transform = m3.multiply(pixToClip, toDocPx);
    gl.uniformMatrix3fv(gl.getUniformLocation(blend, "u_transform"), false, transform);
    gl.uniform1f(gl.getUniformLocation(blend, "u_opacity"), 1);
    gl.uniform1i(gl.getUniformLocation(blend, "u_tex"), 0);
    gl.uniform1i(gl.getUniformLocation(blend, "u_srgbSource"), tex.srgb ? 0 : 1);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, tex.tex);
    r.drawQuad();
    gl.disable(gl.BLEND);
    const raw = r.readPixels(target, 0, 0, dw, dh);
    r.deleteFramebuffer(target);
    // Premultiplied linear bytes, bottom-up -> straight sRGB, top-down.
    const out = new Uint8ClampedArray(dw * dh * 4);
    for (let y = 0; y < dh; y++) {
      const srcRow = (dh - 1 - y) * dw * 4;
      const dstRow = y * dw * 4;
      for (let x = 0; x < dw * 4; x += 4) {
        const a = (raw[srcRow + x + 3] ?? 0) / 255;
        const inv = a > 1e-4 ? 1 / a : 0;
        for (let ch = 0; ch < 3; ch++) {
          const lin = ((raw[srcRow + x + ch] ?? 0) / 255) * inv;
          out[dstRow + x + ch] = Math.round(linearToSrgb(lin) * 255);
        }
        out[dstRow + x + 3] = raw[srcRow + x + 3] ?? 0;
      }
    }
    return out;
  }

  // ════════════════════════════════════════════════════════
  //  SELECTION REFINEMENT
  // ════════════════════════════════════════════════════════
  /** Invert the current selection. */
  invertSelection(): void {
    const sel = this.selection;
    if (!sel) return;
    // An empty selection inverts to "select all" (Photoshop parity).
    if (sel.isEmpty()) sel.selectAll();
    else sel.invert();
    this.markDirty();
    this.emit();
  }
  /** Grow the selection by `px` (morphological dilate). */
  expandSelection(px: number): void {
    this.selection?.expand(px);
    this.markDirty();
    this.emit();
  }
  /** Shrink the selection by `px` (morphological erode). */
  contractSelection(px: number): void {
    this.selection?.contract(px);
    this.markDirty();
    this.emit();
  }
  /** Feather (Gaussian-soften) the selection edge by `px`. */
  featherSelection(px: number): void {
    this.selection?.feather(px);
    this.markDirty();
    this.emit();
  }

  /**
   * Replace the selection from a matte/alpha source (e.g. an RMBG "Select
   * Subject" cutout). Accepts an ImageData (alpha channel used; must be
   * doc-sized) or a doc-sized R8/alpha Uint8Array. Optionally feathers the edge.
   */
  setSelectionFromMask(source: ImageData | Uint8Array, feather = 0): void {
    const sel = this.selection;
    if (!sel) return;
    sel.setFromAlpha(source);
    if (feather > 0) sel.feather(feather);
    this.markDirty();
    this.emit();
  }

  /** Render layer texture + wet stroke into a new RGBA8 source; swap + undo. */
  private flattenStrokeToLayer(
    layer: RasterLayer,
    wet: FramebufferHandle,
    isErase: boolean,
  ): void {
    const r = this.renderer!;
    const gl = r.gl;
    const prog = this.strokeApplyProgram!;
    const tex = this.resolveTexture(layer.id);
    if (!tex) return;
    // Snapshot previous pixels for undo BEFORE overwriting.
    const prevSource = layer.source;

    const target = r.createRGBA8Target(layer.width, layer.height);
    gl.bindFramebuffer(gl.FRAMEBUFFER, target.fbo);
    gl.viewport(0, 0, layer.width, layer.height);
    gl.disable(gl.BLEND);
    gl.useProgram(prog);
    gl.uniformMatrix3fv(
      gl.getUniformLocation(prog, "u_transform"),
      false,
      new Float32Array([2, 0, 0, 0, 2, 0, -1, -1, 1]),
    );
    gl.uniform1i(gl.getUniformLocation(prog, "u_layer"), 0);
    gl.uniform1i(gl.getUniformLocation(prog, "u_wet"), 1);
    const col = this.brushColorLinear();
    gl.uniform3f(gl.getUniformLocation(prog, "u_color"), col[0], col[1], col[2]);
    gl.uniform1f(gl.getUniformLocation(prog, "u_opacity"), this.currentBrushOpacity());
    gl.uniform1i(gl.getUniformLocation(prog, "u_mode"), isErase ? 1 : 0);
    gl.uniform1i(gl.getUniformLocation(prog, "u_srgbLayer"), tex.srgb ? 0 : 1);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, tex.tex);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, wet.color.tex);
    r.drawQuad();

    // Read back the new layer pixels (RGBA8, straight, sRGB-encoded) as ImageData.
    const raw = r.readPixels(target, 0, 0, layer.width, layer.height);
    r.deleteFramebuffer(target);
    const newSource = rawToImageData(raw, layer.width, layer.height);

    const id = layer.id;
    const apply = () => {
      this.doc.replaceSource(id, newSource);
      this.textures.delete(id);
    };
    const revert = () => {
      this.doc.replaceSource(id, prevSource);
      this.textures.delete(id);
    };
    apply();
    this.history.push({
      label: isErase ? "Erase" : "Brush",
      bytes: layer.width * layer.height * 4,
      undo: revert,
      redo: apply,
    });
  }

  /** Paint the wet stroke into the layer mask buffer; swap + undo. */
  private flattenStrokeToMask(
    layer: LayerNode,
    wet: FramebufferHandle,
    isErase: boolean,
  ): void {
    const r = this.renderer!;
    const gl = r.gl;
    const prog = this.maskPaintProgram!;
    const mask = layer.mask!;
    const maskTex = this.resolveMaskTexture(layer);
    if (!maskTex) return;
    const prevData = mask.data.slice();

    const target = r.createR8Target(mask.width, mask.height);
    gl.bindFramebuffer(gl.FRAMEBUFFER, target.fbo);
    gl.viewport(0, 0, mask.width, mask.height);
    gl.disable(gl.BLEND);
    gl.useProgram(prog);
    gl.uniformMatrix3fv(
      gl.getUniformLocation(prog, "u_transform"),
      false,
      new Float32Array([2, 0, 0, 0, 2, 0, -1, -1, 1]),
    );
    gl.uniform1i(gl.getUniformLocation(prog, "u_mask"), 0);
    gl.uniform1i(gl.getUniformLocation(prog, "u_wet"), 1);
    gl.uniform1f(gl.getUniformLocation(prog, "u_opacity"), this.currentBrushOpacity());
    gl.uniform1i(gl.getUniformLocation(prog, "u_erase"), isErase ? 1 : 0);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, maskTex.tex);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, wet.color.tex);
    r.drawQuad();

    // The mask render target is written with v_uv.y=0 at framebuffer row 0,
    // and the source mask texture's row 0 is layer-top, so readR8 returns rows
    // top-down in layer space — copy straight through (no Y flip).
    const raw = r.readR8(target, 0, 0, mask.width, mask.height);
    r.deleteFramebuffer(target);
    const newData = new Uint8Array(mask.width * mask.height);
    newData.set(raw.subarray(0, mask.width * mask.height));

    const id = layer.id;
    const apply = () => {
      const m = this.doc.getLayer(id)?.mask;
      if (m) {
        m.data.set(newData);
        this.doc.bumpMaskVersion(id);
      }
      this.maskTextures.delete(id);
    };
    const revert = () => {
      const m = this.doc.getLayer(id)?.mask;
      if (m) {
        m.data.set(prevData);
        this.doc.bumpMaskVersion(id);
      }
      this.maskTextures.delete(id);
    };
    apply();
    this.history.push({
      label: "Paint mask",
      bytes: mask.width * mask.height,
      undo: revert,
      redo: apply,
    });
  }

  // ── parametric ops with undo (called from action helpers) ──
  /**
   * Commit an opacity change as one undo step. The slider mutates `opacity` live
   * during the drag (no history), so the caller passes the pre-drag value as
   * `prev`; we only record a step when it actually changed.
   */
  setLayerOpacityUndoable(id: LayerId, prev: number, next: number): void {
    const layer = this.doc.getLayer(id);
    if (!layer) return;
    this.doc.setOpacity(id, next);
    if (Math.abs(prev - next) < 1e-4) return;
    this.history.push(
      paramCommand(
        "Opacity",
        () => this.doc.setOpacity(id, next),
        () => this.doc.setOpacity(id, prev),
      ),
    );
  }
  setLayerBlendModeUndoable(id: LayerId, next: RasterLayer["blendMode"]): void {
    const layer = this.doc.getLayer(id);
    if (!layer) return;
    const prev = layer.blendMode;
    this.doc.setBlendMode(id, next);
    this.history.push(
      paramCommand(
        "Blend mode",
        () => this.doc.setBlendMode(id, next),
        () => this.doc.setBlendMode(id, prev),
      ),
    );
  }

  // ── color sampling (eyedropper) ─────────────────────────
  /**
   * Sample the composited color at a document-space pixel. Renders the full
   * composite at doc resolution to an RGBA8 target (premultiplied linear),
   * reads back 1px, un-premultiplies, and returns straight sRGB 0..1. Returns
   * transparent black if out of bounds or not ready.
   */
  sampleColorAt(docX: number, docY: number): RGBAColor {
    const r = this.renderer;
    const blend = this.normalBlendProgram;
    if (!r || !blend) return { r: 0, g: 0, b: 0, a: 0 };
    const px = Math.round(docX);
    const py = Math.round(docY);
    if (px < 0 || py < 0 || px >= this.doc.width || py >= this.doc.height) {
      return { r: 0, g: 0, b: 0, a: 0 };
    }
    const gl = r.gl;
    // Composite only the 1px region we need (cheap). Use the NORMAL blend path
    // with fixed-function source-over, like export.ts.
    const target = r.createRGBA8Target(1, 1);
    gl.bindFramebuffer(gl.FRAMEBUFFER, target.fbo);
    gl.viewport(0, 0, 1, 1);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.enable(gl.BLEND);
    gl.blendFuncSeparate(gl.ONE, gl.ONE_MINUS_SRC_ALPHA, gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    gl.useProgram(blend);
    const uTransform = gl.getUniformLocation(blend, "u_transform");
    const uOpacity = gl.getUniformLocation(blend, "u_opacity");
    const uTex = gl.getUniformLocation(blend, "u_tex");
    const uSrgb = gl.getUniformLocation(blend, "u_srgbSource");
    gl.uniform1i(uTex, 0);
    // Map the document so that doc pixel (px,py) lands at the 1x1 target. The
    // target covers doc px [px, px+1] x [py, py+1].
    const pixToClip = m3.pixelToClip(1, 1);
    for (const id of this.doc.orderBottomToTop()) {
      const layer = this.doc.getLayer(id);
      if (!layer || !layer.visible || layer.opacity <= 0) continue;
      if (!isPixelLayer(layer)) continue; // adjustments don't add pixels here
      const tex = this.resolveTexture(id);
      if (!tex) continue;
      const toDocPx = m3.multiply(
        m3.translation(layer.x - px, layer.y - py),
        m3.scaling(layer.width, layer.height),
      );
      const transform = m3.multiply(pixToClip, toDocPx);
      gl.uniformMatrix3fv(uTransform, false, transform);
      gl.uniform1f(uOpacity, layer.opacity);
      gl.uniform1i(uSrgb, tex.srgb ? 0 : 1);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, tex.tex);
      r.drawQuad();
    }
    gl.disable(gl.BLEND);
    const raw = r.readPixels(target, 0, 0, 1, 1);
    r.deleteFramebuffer(target);
    const a = (raw[3] ?? 0) / 255;
    const inv = a > 1e-4 ? 1 / a : 0;
    return {
      r: linearToSrgb(((raw[0] ?? 0) / 255) * inv),
      g: linearToSrgb(((raw[1] ?? 0) / 255) * inv),
      b: linearToSrgb(((raw[2] ?? 0) / 255) * inv),
      a,
    };
  }

  // ── fill + gradient ─────────────────────────────────────
  /**
   * Fill the active layer's selected region (or whole layer when no selection)
   * with a solid sRGB straight color. One undo step. No-op for adjustment layers.
   */
  fillSelection(color: RGBAColor, layerId?: LayerId): void {
    const id = layerId ?? this.doc.getActiveLayerId();
    if (!id) return;
    const layer = this.doc.getLayer(id);
    if (!layer || layer.kind !== "raster") return;
    this.fillLayerRegion(layer, color);
  }

  private fillLayerRegion(layer: RasterLayer, color: RGBAColor): void {
    const r = this.renderer;
    if (!r) return;
    const gl = r.gl;
    const tex = this.resolveTexture(layer.id);
    if (!tex) return;
    const prog = this.fillProgram();
    const prevSource = layer.source;

    const target = r.createRGBA8Target(layer.width, layer.height);
    gl.bindFramebuffer(gl.FRAMEBUFFER, target.fbo);
    gl.viewport(0, 0, layer.width, layer.height);
    gl.disable(gl.BLEND);
    gl.useProgram(prog);
    gl.uniformMatrix3fv(
      gl.getUniformLocation(prog, "u_transform"),
      false,
      new Float32Array([2, 0, 0, 0, 2, 0, -1, -1, 1]),
    );
    gl.uniform1i(gl.getUniformLocation(prog, "u_layer"), 0);
    gl.uniform1i(gl.getUniformLocation(prog, "u_srgbLayer"), tex.srgb ? 0 : 1);
    gl.uniform4f(
      gl.getUniformLocation(prog, "u_color"),
      color.r, color.g, color.b, color.a,
    );
    // Selection sampling: gate the fill by the doc selection over the layer.
    const sel = this.selection;
    const useSel = !!sel && !sel.isEmpty() && !!sel.texture;
    gl.uniform1i(gl.getUniformLocation(prog, "u_useSelection"), useSel ? 1 : 0);
    if (useSel && sel) {
      const { width: dw, height: dh } = sel.size;
      // layer uv -> doc px -> sel uv. layerUv*[lw,lh] + [lx,ly] = docPx.
      const uvToSel = new Float32Array([
        layer.width / dw, 0, 0,
        0, layer.height / dh, 0,
        layer.x / dw, layer.y / dh, 1,
      ]);
      gl.uniformMatrix3fv(gl.getUniformLocation(prog, "u_uvToSel"), false, uvToSel);
      gl.uniform1i(gl.getUniformLocation(prog, "u_selection"), 1);
      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_2D, sel.texture!);
    }
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, tex.tex);
    r.drawQuad();

    const rawPx = r.readPixels(target, 0, 0, layer.width, layer.height);
    r.deleteFramebuffer(target);
    const newSource = rawToImageData(rawPx, layer.width, layer.height);
    const lid = layer.id;
    const apply = () => {
      this.doc.replaceSource(lid, newSource);
      this.textures.delete(lid);
    };
    const revert = () => {
      this.doc.replaceSource(lid, prevSource);
      this.textures.delete(lid);
    };
    apply();
    this.history.push({
      label: "Fill",
      bytes: layer.width * layer.height * 4,
      undo: revert,
      redo: apply,
    });
    this.markDirty();
  }

  /**
   * Render a linear/radial gradient into a layer's selected region (or whole
   * layer). `from`/`to` are document-space points. Stops default to fg->bg.
   * One undo step. No-op for adjustment layers.
   */
  applyGradientFill(
    layerId: LayerId,
    opts: {
      type: "linear" | "radial";
      from: { x: number; y: number };
      to: { x: number; y: number };
      stops?: GradientStop[];
    },
  ): void {
    const r = this.renderer;
    if (!r) return;
    const layer = this.doc.getLayer(layerId);
    if (!layer || layer.kind !== "raster") return;
    const gl = r.gl;
    const tex = this.resolveTexture(layer.id);
    if (!tex) return;

    // Default stops fg -> bg (sRGB straight).
    const ts = toolStore.get();
    const stops: GradientStop[] = normalizeStops(
      opts.stops ?? [
        { pos: 0, color: { ...ts.foreground } },
        { pos: 1, color: { ...ts.background } },
      ],
    );
    // Bake a 256-entry LUT in linear light (the shader writes sRGB on store).
    const lutBytes = new Uint8Array(256 * 4);
    for (let i = 0; i < 256; i++) {
      const c = sampleGradient(stops, i / 255);
      lutBytes[i * 4] = Math.round(Math.min(1, Math.max(0, c.r)) * 255);
      lutBytes[i * 4 + 1] = Math.round(Math.min(1, Math.max(0, c.g)) * 255);
      lutBytes[i * 4 + 2] = Math.round(Math.min(1, Math.max(0, c.b)) * 255);
      // Alpha interpolation across stops (linear).
      lutBytes[i * 4 + 3] = Math.round(sampleGradientAlpha(stops, i / 255) * 255);
    }
    const lutTex = r.createRGBA8Texture(lutBytes, 256, 1, { srgb: false });

    const prog = this.gradientProgram();
    const prevSource = layer.source;
    const target = r.createRGBA8Target(layer.width, layer.height);
    gl.bindFramebuffer(gl.FRAMEBUFFER, target.fbo);
    gl.viewport(0, 0, layer.width, layer.height);
    gl.disable(gl.BLEND);
    gl.useProgram(prog);
    gl.uniformMatrix3fv(
      gl.getUniformLocation(prog, "u_transform"),
      false,
      new Float32Array([2, 0, 0, 0, 2, 0, -1, -1, 1]),
    );
    gl.uniform1i(gl.getUniformLocation(prog, "u_layer"), 0);
    gl.uniform1i(gl.getUniformLocation(prog, "u_lut"), 1);
    gl.uniform1i(gl.getUniformLocation(prog, "u_srgbLayer"), tex.srgb ? 0 : 1);
    gl.uniform1i(gl.getUniformLocation(prog, "u_radial"), opts.type === "radial" ? 1 : 0);
    // from/to in layer-local px.
    gl.uniform2f(gl.getUniformLocation(prog, "u_from"), opts.from.x - layer.x, opts.from.y - layer.y);
    gl.uniform2f(gl.getUniformLocation(prog, "u_to"), opts.to.x - layer.x, opts.to.y - layer.y);
    gl.uniform2f(gl.getUniformLocation(prog, "u_size"), layer.width, layer.height);
    const sel = this.selection;
    const useSel = !!sel && !sel.isEmpty() && !!sel.texture;
    gl.uniform1i(gl.getUniformLocation(prog, "u_useSelection"), useSel ? 1 : 0);
    if (useSel && sel) {
      const { width: dw, height: dh } = sel.size;
      const uvToSel = new Float32Array([
        layer.width / dw, 0, 0,
        0, layer.height / dh, 0,
        layer.x / dw, layer.y / dh, 1,
      ]);
      gl.uniformMatrix3fv(gl.getUniformLocation(prog, "u_uvToSel"), false, uvToSel);
      gl.uniform1i(gl.getUniformLocation(prog, "u_selection"), 2);
      gl.activeTexture(gl.TEXTURE2);
      gl.bindTexture(gl.TEXTURE_2D, sel.texture!);
    }
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, tex.tex);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, lutTex.tex);
    r.drawQuad();
    r.deleteTexture(lutTex);

    const rawPx = r.readPixels(target, 0, 0, layer.width, layer.height);
    r.deleteFramebuffer(target);
    const newSource = rawToImageData(rawPx, layer.width, layer.height);
    const lid = layer.id;
    const apply = () => {
      this.doc.replaceSource(lid, newSource);
      this.textures.delete(lid);
    };
    const revert = () => {
      this.doc.replaceSource(lid, prevSource);
      this.textures.delete(lid);
    };
    apply();
    this.history.push({
      label: "Gradient",
      bytes: layer.width * layer.height * 4,
      undo: revert,
      redo: apply,
    });
    this.markDirty();
  }

  // Lazily-compiled fill + gradient programs.
  private _fillProg: WebGLProgram | null = null;
  private fillProgram(): WebGLProgram {
    if (this._fillProg) return this._fillProg;
    const frag = /* glsl */ `#version 300 es
precision highp float;
in vec2 v_uv; out vec4 fragColor;
uniform sampler2D u_layer;
uniform sampler2D u_selection;
uniform bool u_useSelection;
uniform bool u_srgbLayer;
uniform vec4 u_color;        // straight sRGB
uniform mat3 u_uvToSel;
vec3 srgbToLinear(vec3 c){return mix(c/12.92, pow((c+0.055)/1.055, vec3(2.4)), step(0.04045,c));}
vec3 linearToSrgb(vec3 c){return mix(c*12.92, 1.055*pow(c, vec3(1.0/2.4))-0.055, step(0.0031308,c));}
void main(){
  vec4 base = texture(u_layer, v_uv);
  vec3 baseLin = u_srgbLayer ? srgbToLinear(base.rgb) : base.rgb;
  float cov = u_color.a;
  if (u_useSelection) { vec3 s = u_uvToSel*vec3(v_uv,1.0); cov *= texture(u_selection, s.xy).r; }
  vec3 fillLin = srgbToLinear(u_color.rgb);
  float oa = cov + base.a*(1.0-cov);
  vec3 oc = oa>1e-5 ? (fillLin*cov + baseLin*base.a*(1.0-cov))/oa : vec3(0.0);
  fragColor = vec4(linearToSrgb(oc), oa);
}`;
    this._fillProg = this.renderer!.compileProgram(QUAD_VERT, frag);
    return this._fillProg;
  }

  private _gradProg: WebGLProgram | null = null;
  private gradientProgram(): WebGLProgram {
    if (this._gradProg) return this._gradProg;
    const frag = /* glsl */ `#version 300 es
precision highp float;
in vec2 v_uv; out vec4 fragColor;
uniform sampler2D u_layer;
uniform sampler2D u_lut;       // straight sRGB gradient, RGBA
uniform sampler2D u_selection;
uniform bool u_useSelection;
uniform bool u_srgbLayer;
uniform bool u_radial;
uniform vec2 u_from;           // layer px
uniform vec2 u_to;
uniform vec2 u_size;           // layer px
uniform mat3 u_uvToSel;
vec3 srgbToLinear(vec3 c){return mix(c/12.92, pow((c+0.055)/1.055, vec3(2.4)), step(0.04045,c));}
vec3 linearToSrgb(vec3 c){return mix(c*12.92, 1.055*pow(c, vec3(1.0/2.4))-0.055, step(0.0031308,c));}
void main(){
  vec2 p = v_uv * u_size;      // layer px
  float t;
  if (u_radial) {
    float rad = length(u_to - u_from);
    t = rad > 1e-4 ? length(p - u_from)/rad : 0.0;
  } else {
    vec2 d = u_to - u_from;
    float len2 = dot(d,d);
    t = len2 > 1e-4 ? dot(p - u_from, d)/len2 : 0.0;
  }
  t = clamp(t, 0.0, 1.0);
  vec4 g = texture(u_lut, vec2(t, 0.5));     // straight sRGB + alpha
  vec3 gLin = srgbToLinear(g.rgb);
  float cov = g.a;
  if (u_useSelection) { vec3 s = u_uvToSel*vec3(v_uv,1.0); cov *= texture(u_selection, s.xy).r; }
  vec4 base = texture(u_layer, v_uv);
  vec3 baseLin = u_srgbLayer ? srgbToLinear(base.rgb) : base.rgb;
  float oa = cov + base.a*(1.0-cov);
  vec3 oc = oa>1e-5 ? (gLin*cov + baseLin*base.a*(1.0-cov))/oa : vec3(0.0);
  fragColor = vec4(linearToSrgb(oc), oa);
}`;
    this._gradProg = this.renderer!.compileProgram(QUAD_VERT, frag);
    return this._gradProg;
  }

  // ── adjustment layers ───────────────────────────────────
  /**
   * Insert a non-destructive adjustment layer above the active layer. One undo
   * step. Returns the new layer id.
   */
  addAdjustmentLayer(
    adjustmentType: AdjustmentType,
    params?: AdjustmentParams,
  ): LayerId {
    const p = params ?? defaultAdjustmentParams(adjustmentType);
    const id = this.doc.addAdjustmentLayer(adjustmentType, p);
    this.history.push(
      paramCommand(
        "Add adjustment layer",
        () => {}, // forward already applied
        () => this.doc.remove(id),
      ),
    );
    this.markDirty();
    return id;
  }

  /**
   * Live-update an adjustment layer's params (no per-tick undo; the caller
   * passes the pre-edit params to `commitAdjustmentParams` to record one step).
   */
  updateAdjustmentParams(id: LayerId, patch: AdjustmentParams): void {
    this.doc.updateAdjustmentParams(id, patch);
    this.markDirty();
  }

  /** Record a single undo step for an adjustment param edit (on commit). */
  commitAdjustmentParams(
    id: LayerId,
    prev: AdjustmentParams,
    next: AdjustmentParams,
  ): void {
    const before = structuredClone(prev);
    const after = structuredClone(next);
    this.doc.setAdjustmentParams(id, after);
    this.history.push(
      paramCommand(
        "Edit adjustment",
        () => this.doc.setAdjustmentParams(id, structuredClone(after)),
        () => this.doc.setAdjustmentParams(id, structuredClone(before)),
      ),
    );
    this.markDirty();
  }

  /** Toggle clipping an adjustment to the layer directly below (one undo step). */
  setAdjustmentClipping(id: LayerId, clipping: boolean): void {
    this.setClipping(id, clipping);
  }

  /**
   * Toggle clipping a layer (adjustment OR pixel layer) to the alpha of the
   * layer directly below it within the same group. One undo step.
   */
  setClipping(id: LayerId, clipping: boolean): void {
    const layer = this.doc.getLayer(id);
    if (!layer) return;
    if (layer.kind !== "adjustment" && layer.kind !== "raster" && layer.kind !== "text") return;
    const prev = !!(layer as AdjustmentLayer | PixelLayer).clipping;
    this.doc.setClipping(id, clipping);
    if (prev === clipping) return;
    this.history.push(
      paramCommand(
        "Clipping",
        () => this.doc.setClipping(id, clipping),
        () => this.doc.setClipping(id, prev),
      ),
    );
    this.markDirty();
  }

  // ════════════════════════════════════════════════════════
  //  LAYER GROUPS
  // ════════════════════════════════════════════════════════
  /** Create a new empty group at the top of the document (one undo step). */
  addGroup(name?: string): LayerId {
    const id = this.doc.addGroup(name);
    const node = this.doc.getLayer(id)!;
    const after = this.doc.captureStructure();
    this.history.push({
      label: "New Group",
      bytes: 0,
      undo: () => this.doc.remove(id),
      redo: () => {
        this.doc.reinsertNode(node);
        this.doc.restoreStructure(after);
      },
    });
    this.markDirty();
    return id;
  }

  /**
   * Wrap the given layers in a new group (one undo step). Returns the new group
   * id, or null if nothing groupable was supplied.
   */
  groupLayers(ids: LayerId[], name?: string): LayerId | null {
    const before = this.doc.captureStructure();
    const groupId = this.doc.groupLayers(ids, name);
    if (groupId === null) return null;
    const groupNode = this.doc.getLayer(groupId)!;
    const after = this.doc.captureStructure();
    const prevActive = this.doc.getActiveLayerId();
    this.history.push({
      label: "Group Layers",
      bytes: 0,
      undo: () => {
        // Drop the group node + relink everything to the pre-group structure.
        this.doc.restoreStructure(before);
        this.doc.remove(groupId);
        this.doc.setActive(prevActive);
      },
      redo: () => {
        this.doc.reinsertNode(groupNode);
        this.doc.restoreStructure(after);
        this.doc.setActive(groupId);
      },
    });
    this.markDirty();
    return groupId;
  }

  /** Dissolve a group, splicing its children back into place (one undo step). */
  ungroup(groupId: LayerId): void {
    const group = this.doc.getLayer(groupId);
    if (!group || group.kind !== "group") return;
    const groupNode = group;
    const before = this.doc.captureStructure();
    this.doc.ungroup(groupId);
    const after = this.doc.captureStructure();
    this.history.push({
      label: "Ungroup",
      bytes: 0,
      undo: () => {
        this.doc.reinsertNode(groupNode);
        this.doc.restoreStructure(before);
      },
      redo: () => {
        this.doc.restoreStructure(after);
        this.doc.remove(groupId);
      },
    });
    this.markDirty();
  }

  /** Move a layer into a group at a child index (one undo step). */
  moveLayerIntoGroup(id: LayerId, groupId: LayerId, index = -1): void {
    const before = this.doc.captureStructure();
    this.doc.moveLayerIntoGroup(id, groupId, index);
    const after = this.doc.captureStructure();
    this.history.push(
      paramCommand(
        "Move into group",
        () => this.doc.restoreStructure(after),
        () => this.doc.restoreStructure(before),
      ),
    );
    this.markDirty();
  }

  /** Move a layer to the document root at an index (pull out of a group). */
  moveLayerToRoot(id: LayerId, index = -1): void {
    const before = this.doc.captureStructure();
    this.doc.moveLayerToRoot(id, index);
    const after = this.doc.captureStructure();
    this.history.push(
      paramCommand(
        "Move to root",
        () => this.doc.restoreStructure(after),
        () => this.doc.restoreStructure(before),
      ),
    );
    this.markDirty();
  }

  /** Collapse / expand a group's children rows in the UI (no undo step). */
  setGroupCollapsed(id: LayerId, collapsed: boolean): void {
    this.doc.setCollapsed(id, collapsed);
    this.markDirty();
  }

  // ════════════════════════════════════════════════════════
  //  LAYER STYLES / EFFECTS
  // ════════════════════════════════════════════════════════
  /**
   * Live-update one layer effect (merge a patch into the named effect). No
   * per-tick undo — the caller records a single step via commitLayerEffects with
   * the pre-edit effects bag. No-op for non-pixel layers.
   */
  updateLayerEffect(
    id: LayerId,
    type: LayerEffectType,
    patch: Record<string, unknown>,
  ): void {
    const layer = this.doc.getLayer(id);
    if (!layer || !isPixelLayer(layer)) return;
    const fx: LayerEffects = layer.effects ? structuredClone(layer.effects) : {};
    const cur = (fx[type] ?? {}) as Record<string, unknown>;
    (fx as Record<string, unknown>)[type] = { ...DEFAULT_EFFECTS[type], ...cur, ...patch };
    this.doc.setEffects(id, fx);
    this.textures.delete(id); // effect derives from alpha; texture is unchanged but markDirty re-renders
    this.markDirty();
  }

  /** Replace a layer's whole effects bag live (no undo). */
  setLayerEffects(id: LayerId, effects: LayerEffects | undefined): void {
    const layer = this.doc.getLayer(id);
    if (!layer || !isPixelLayer(layer)) return;
    this.doc.setEffects(id, effects ? structuredClone(effects) : undefined);
    this.markDirty();
  }

  /** Record one undo step for an effects edit (prev/next full bags). */
  commitLayerEffects(
    id: LayerId,
    prev: LayerEffects | undefined,
    next: LayerEffects | undefined,
  ): void {
    const before = prev ? structuredClone(prev) : undefined;
    const after = next ? structuredClone(next) : undefined;
    this.doc.setEffects(id, after ? structuredClone(after) : undefined);
    this.history.push(
      paramCommand(
        "Layer Style",
        () => this.doc.setEffects(id, after ? structuredClone(after) : undefined),
        () => this.doc.setEffects(id, before ? structuredClone(before) : undefined),
      ),
    );
    this.markDirty();
  }

  /** Snapshot a copy of a layer's current effects (for undo bookkeeping). */
  getLayerEffects(id: LayerId): LayerEffects | undefined {
    return this.doc.getEffects(id);
  }

  // ════════════════════════════════════════════════════════
  //  HISTORY LIST (for a History panel)
  // ════════════════════════════════════════════════════════
  /** Ordered history entries (oldest -> newest) + the current position. */
  getHistory(): { entries: { label: string; index: number }[]; currentIndex: number } {
    return { entries: this.history.getEntries(), currentIndex: this.history.currentIndex() };
  }
  /** Undo/redo until the history cursor lands on `index` (see History.jumpTo). */
  historyJumpTo(index: number): void {
    this.history.jumpTo(index);
    this.refreshAfterHistory();
  }

  // ── histogram ───────────────────────────────────────────
  /**
   * Per-channel + luma 256-bin histogram of a raster layer's pixels (straight
   * sRGB values, like the Levels/Curves panels expect). Reads the layer texture
   * back via an RGBA8 target. Returns zero-filled bins for adjustment layers.
   */
  getLayerHistogram(layerId: LayerId): {
    r: Uint32Array;
    g: Uint32Array;
    b: Uint32Array;
    luma: Uint32Array;
  } {
    const empty = () => ({
      r: new Uint32Array(256),
      g: new Uint32Array(256),
      b: new Uint32Array(256),
      luma: new Uint32Array(256),
    });
    const r = this.renderer;
    const layer = this.doc.getLayer(layerId);
    if (!r || !layer || layer.kind !== "raster") return empty();
    const tex = this.resolveTexture(layerId);
    if (!tex) return empty();
    const gl = r.gl;
    // Blit the (sRGB-decoding) layer texture into an RGBA8 target, re-encoding
    // to sRGB bytes so the readback is the layer's display values.
    const prog = this.histogramBlitProgram();
    const target = r.createRGBA8Target(layer.width, layer.height);
    gl.bindFramebuffer(gl.FRAMEBUFFER, target.fbo);
    gl.viewport(0, 0, layer.width, layer.height);
    gl.disable(gl.BLEND);
    gl.useProgram(prog);
    gl.uniformMatrix3fv(
      gl.getUniformLocation(prog, "u_transform"),
      false,
      new Float32Array([2, 0, 0, 0, 2, 0, -1, -1, 1]),
    );
    gl.uniform1i(gl.getUniformLocation(prog, "u_src"), 0);
    gl.uniform1i(gl.getUniformLocation(prog, "u_srgbSource"), tex.srgb ? 0 : 1);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, tex.tex);
    r.drawQuad();
    const px = r.readPixels(target, 0, 0, layer.width, layer.height);
    r.deleteFramebuffer(target);

    const out = empty();
    for (let i = 0; i < px.length; i += 4) {
      const a = px[i + 3] ?? 0;
      if (a === 0) continue; // ignore fully transparent pixels
      const rv = px[i] ?? 0;
      const gv = px[i + 1] ?? 0;
      const bv = px[i + 2] ?? 0;
      out.r[rv]!++;
      out.g[gv]!++;
      out.b[bv]!++;
      const l = Math.min(255, Math.round(0.299 * rv + 0.587 * gv + 0.114 * bv));
      out.luma[l]!++;
    }
    return out;
  }

  private _histProg: WebGLProgram | null = null;
  private histogramBlitProgram(): WebGLProgram {
    if (this._histProg) return this._histProg;
    const frag = /* glsl */ `#version 300 es
precision highp float;
in vec2 v_uv; out vec4 fragColor;
uniform sampler2D u_src;
uniform bool u_srgbSource;
vec3 linearToSrgb(vec3 c){return mix(c*12.92, 1.055*pow(c, vec3(1.0/2.4))-0.055, step(0.0031308,c));}
void main(){
  vec4 c = texture(u_src, v_uv);
  // SRGB textures decode to linear on sample; re-encode for display values.
  vec3 disp = u_srgbSource ? c.rgb : linearToSrgb(c.rgb);
  fragColor = vec4(disp, c.a);
}`;
    this._histProg = this.renderer!.compileProgram(QUAD_VERT, frag);
    return this._histProg;
  }

  // ── destructive filters ─────────────────────────────────
  /** Get (compiling on first use) the filter program for a type. */
  private filterProgram(type: FilterType): WebGLProgram | null {
    const r = this.renderer;
    if (!r) return null;
    let prog = this.filterPrograms.get(type);
    if (!prog) {
      prog = r.compileProgram(QUAD_VERT, FILTERS[type].fragSource);
      this.filterPrograms.set(type, prog);
    }
    return prog;
  }

  /**
   * Run a filter pipeline over a raster layer's texture into a fresh RGBA8
   * target and return it (caller owns nothing — it's kept in a transient that
   * the engine deletes on the next preview frame). Used by both preview and
   * commit. Returns null on failure.
   */
  private filterScratch: FramebufferHandle | null = null;
  private runFilterToTexture(
    layer: RasterLayer,
    type: FilterType,
    params: FilterParams,
  ): TextureHandle | null {
    const r = this.renderer;
    if (!r) return null;
    const def = FILTERS[type];
    const prog = this.filterProgram(type);
    if (!prog) return null;
    const tex = this.resolveTexture(layer.id);
    if (!tex) return null;
    const gl = r.gl;
    const w = layer.width;
    const h = layer.height;
    const passes = Math.max(1, def.passes(params));

    // Ping-pong two RGBA8 targets. Pass 0 reads the layer; later passes read
    // the previous target.
    const a = r.createRGBA8Target(w, h);
    const b = r.createRGBA8Target(w, h);
    let srcTex: TextureHandle = tex;
    for (let pass = 0; pass < passes; pass++) {
      const dst = pass % 2 === 0 ? a : b;
      gl.bindFramebuffer(gl.FRAMEBUFFER, dst.fbo);
      gl.viewport(0, 0, w, h);
      gl.disable(gl.BLEND);
      gl.useProgram(prog);
      gl.uniformMatrix3fv(
        gl.getUniformLocation(prog, "u_transform"),
        false,
        new Float32Array([2, 0, 0, 0, 2, 0, -1, -1, 1]),
      );
      gl.uniform1i(gl.getUniformLocation(prog, "u_src"), 0);
      gl.uniform2f(gl.getUniformLocation(prog, "u_texel"), 1 / w, 1 / h);
      // Pass 0 reads the SRGB-decoding layer texture (decode → re-encode to
      // display sRGB); later passes read RGBA8 display-sRGB bytes verbatim.
      gl.uniform1i(gl.getUniformLocation(prog, "u_decodeSrc"), srcTex.srgb ? 1 : 0);
      def.setUniforms({
        gl,
        loc: (n) => gl.getUniformLocation(prog, n),
        params,
        pass,
        width: w,
        height: h,
      });
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, srcTex.tex);
      r.drawQuad();
      // After pass 0, intermediate targets hold display-sRGB RGBA8 bytes
      // (srgb:false), so subsequent passes pass them through verbatim.
      srcTex = dst.color;
    }
    const finalFb = (passes - 1) % 2 === 0 ? a : b;
    // Keep finalFb alive (return its color); delete the other.
    const other = finalFb === a ? b : a;
    r.deleteFramebuffer(other);
    // Stash the kept FBO so the next preview frame / commit can free it.
    if (this.filterScratch) r.deleteFramebuffer(this.filterScratch);
    this.filterScratch = finalFb;
    return finalFb.color;
  }

  /**
   * Apply a filter destructively to a layer: render through the pipeline, read
   * back, replaceSource, one undo step. Cancels any live preview first.
   */
  applyFilter(layerId: LayerId, type: FilterType, params?: FilterParams): void {
    const r = this.renderer;
    if (!r) return;
    const layer = this.doc.getLayer(layerId);
    if (!layer || layer.kind !== "raster") return;
    this.cancelFilter(); // clear any preview state for this/other layer
    const p = params ?? defaultFilterParams(type);
    const filtered = this.runFilterToTexture(layer, type, p);
    const fb = this.filterScratch;
    if (!filtered || !fb) return;
    const rawPx = r.readPixels(fb, 0, 0, layer.width, layer.height);
    r.deleteFramebuffer(fb);
    this.filterScratch = null;
    const newSource = rawToImageData(rawPx, layer.width, layer.height);
    const prevSource = layer.source;
    const lid = layer.id;
    const apply = () => {
      this.doc.replaceSource(lid, newSource);
      this.textures.delete(lid);
    };
    const revert = () => {
      this.doc.replaceSource(lid, prevSource);
      this.textures.delete(lid);
    };
    apply();
    this.history.push({
      label: FILTERS[type].label,
      bytes: layer.width * layer.height * 4,
      undo: revert,
      redo: apply,
    });
    this.markDirty();
  }

  /**
   * Begin / update a live filter preview on a layer (non-committed). The render
   * loop substitutes the filtered texture for this layer until commit/cancel.
   */
  previewFilter(layerId: LayerId, type: FilterType, params?: FilterParams): void {
    const layer = this.doc.getLayer(layerId);
    if (!layer || layer.kind !== "raster") return;
    this.filterPreview = {
      layerId,
      type,
      params: params ?? defaultFilterParams(type),
    };
    this.markDirty();
  }

  /** Commit the active filter preview as a destructive edit (one undo step). */
  commitFilter(): void {
    const fp = this.filterPreview;
    this.filterPreview = null;
    if (this.filterScratch) {
      this.renderer?.deleteFramebuffer(this.filterScratch);
      this.filterScratch = null;
    }
    if (!fp) return;
    this.applyFilter(fp.layerId, fp.type, fp.params);
  }

  /** Discard the active filter preview without committing. */
  cancelFilter(): void {
    this.filterPreview = null;
    if (this.filterScratch) {
      this.renderer?.deleteFramebuffer(this.filterScratch);
      this.filterScratch = null;
    }
    this.markDirty();
  }

  /**
   * Composite the whole document (raster + adjustment layers) at document
   * resolution into a fresh RGBA8 target (premultiplied linear), and return it.
   * The caller owns the framebuffer and must delete it. Used by export.ts so
   * the saved PNG includes adjustment layers. Returns null if not ready.
   *
   * Uses the same ping-pong fold as the viewport render(), but with an identity
   * view transform and doc-sized accumulators, and writes a normal source-over
   * composite (no checkerboard / present pass).
   */
  renderDocumentComposite(): FramebufferHandle | null {
    const r = this.renderer;
    if (!r || !this.blendProgram || !this.copyProgram) return null;
    const gl = r.gl;
    const w = Math.max(1, Math.round(this.doc.width));
    const h = Math.max(1, Math.round(this.doc.height));

    let read = r.createColorTarget(w, h);
    let write = r.createColorTarget(w, h);
    gl.bindFramebuffer(gl.FRAMEBUFFER, read.fbo);
    gl.viewport(0, 0, w, h);
    gl.disable(gl.BLEND);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);

    const pixToClip = m3.pixelToClip(w, h);
    const view = m3.identity();
    // Stash + override the live view so adjustment/group uv->doc math uses
    // identity (doc-resolution export, no pan/zoom).
    const savedView = this.view;
    this.view = { scale: 1, tx: 0, ty: 0 };

    // Same tree fold as the viewport render(), minus the brush preview, so the
    // export includes groups, clipping and layer effects.
    const res = this.compositeList(
      this.doc.orderBottomToTop(),
      read,
      write,
      w,
      h,
      view,
      pixToClip,
      /*allowBrushPreview*/ false,
    );
    read = res.read;
    write = res.write;
    this.view = savedView;
    this.markDirty();

    // Copy the linear float accumulator into an RGBA8 target via the blit so the
    // caller can read it back as bytes (float-FBO byte readback returns zeros).
    const out = r.createRGBA8Target(w, h);
    gl.bindFramebuffer(gl.FRAMEBUFFER, out.fbo);
    gl.viewport(0, 0, w, h);
    gl.disable(gl.BLEND);
    this.blitBackdrop(read);
    r.deleteFramebuffer(read);
    r.deleteFramebuffer(write);
    return out;
  }

  // ════════════════════════════════════════════════════════
  //  FREE TRANSFORM
  // ════════════════════════════════════════════════════════
  /**
   * Doc-space model matrix mapping the unit quad to a pixel layer's footprint,
   * folding in the live free-transform when this layer is under an active
   * session. The transform is: translate (dx,dy), then rotate+scale about the
   * base footprint's center.
   */
  private layerModelMatrix(layer: LayerNode): Float32Array {
    const base = m3.multiply(
      m3.translation((layer as PixelLayer).x, (layer as PixelLayer).y),
      m3.scaling((layer as PixelLayer).width, (layer as PixelLayer).height),
    );
    const sess = this.transformSession;
    if (!sess || sess.layerId !== layer.id) return base;
    const t = sess.base;
    const b = sess.baseBounds;
    const cx = b.x + b.width / 2;
    const cy = b.y + b.height / 2;
    // M = T(dx,dy) * T(cx,cy) * R * S * T(-cx,-cy) * base
    let m = m3.translation(t.dx, t.dy);
    m = m3.multiply(m, m3.translation(cx, cy));
    m = m3.multiply(m, m3.rotation((t.rotDeg * Math.PI) / 180));
    m = m3.multiply(m, m3.scaling(t.scaleX, t.scaleY));
    m = m3.multiply(m, m3.translation(-cx, -cy));
    m = m3.multiply(m, base);
    return m;
  }

  /**
   * The four transformed corners of a layer's footprint in DOC space, applying
   * the live transform if active. Order: NW, NE, SE, SW.
   */
  private transformedCornersDoc(
    layer: PixelLayer,
  ): { x: number; y: number }[] {
    const sess = this.transformSession;
    const corners = [
      { x: 0, y: 0 },
      { x: 1, y: 0 },
      { x: 1, y: 1 },
      { x: 0, y: 1 },
    ];
    if (sess && sess.layerId === layer.id) {
      const t = sess.base;
      const b = sess.baseBounds;
      const cx = b.x + b.width / 2;
      const cy = b.y + b.height / 2;
      let m = m3.translation(t.dx, t.dy);
      m = m3.multiply(m, m3.translation(cx, cy));
      m = m3.multiply(m, m3.rotation((t.rotDeg * Math.PI) / 180));
      m = m3.multiply(m, m3.scaling(t.scaleX, t.scaleY));
      m = m3.multiply(m, m3.translation(-cx, -cy));
      m = m3.multiply(m, m3.translation(layer.x, layer.y));
      m = m3.multiply(m, m3.scaling(layer.width, layer.height));
      return corners.map((c) => m3.transformPoint(m, c.x, c.y));
    }
    return corners.map((c) => ({
      x: layer.x + c.x * layer.width,
      y: layer.y + c.y * layer.height,
    }));
  }

  /** Doc px -> screen (CSS px relative to canvas). Inverse of screenToDoc. */
  private docToScreen(x: number, y: number): { x: number; y: number } {
    return {
      x: (x * this.view.scale + this.view.tx) / this.dpr,
      y: (y * this.view.scale + this.view.ty) / this.dpr,
    };
  }

  /** Top-most visible text layer whose footprint contains (docX,docY), or null. */
  private hitTestTopTextLayer(docX: number, docY: number): LayerId | null {
    const order = this.doc.orderBottomToTop();
    for (let i = order.length - 1; i >= 0; i--) {
      const l = this.doc.getLayer(order[i]!);
      if (!l || l.kind !== "text" || !l.visible) continue;
      this.ensureTextRasterized(l);
      if (docX >= l.x && docX <= l.x + l.width && docY >= l.y && docY <= l.y + l.height) {
        return l.id;
      }
    }
    return null;
  }

  /**
   * Begin a free-transform session on a layer (defaults to the active layer).
   * Only pixel layers (raster/text) transform. No-op when one is already active
   * on a different layer (commit/cancel first). Switches the active tool to
   * 'transform' so pointer routing engages.
   */
  beginTransform(layerId?: LayerId): void {
    const id = layerId ?? this.doc.getActiveLayerId();
    if (!id) return;
    const layer = this.doc.getLayer(id);
    if (!layer || !isPixelLayer(layer)) return;
    // Text layers must be rasterized so the footprint is known.
    if (layer.kind === "text") this.ensureTextRasterized(layer);
    this.transformSession = {
      layerId: id,
      base: { ...IDENTITY_TRANSFORM },
      baseBounds: { x: layer.x, y: layer.y, width: layer.width, height: layer.height },
    };
    toolStore.setActive("transform");
    this.markDirty();
    this.emit();
  }

  /** Whether a free-transform session is active. */
  isTransforming(): boolean {
    return this.transformSession !== null;
  }

  /**
   * Live transform state for a UI overlay. `bounds` is the screen-space AABB of
   * the (possibly rotated) box; `handles` are the 8 box handles in screen px;
   * `corners` are the 4 transformed corners in screen px (NW,NE,SE,SW) so the
   * overlay can draw the rotated outline. Null when no session is active.
   */
  getTransformState(): {
    layerId: LayerId;
    bounds: { x: number; y: number; width: number; height: number };
    corners: { x: number; y: number }[];
    handles: { id: TransformHandleId; x: number; y: number }[];
    rotationDeg: number;
    /** Live transform scalars (so the option bar's W/H% fields stay accurate
     *  during on-canvas handle drags instead of being write-only). */
    scaleX: number;
    scaleY: number;
    dx: number;
    dy: number;
  } | null {
    const sess = this.transformSession;
    if (!sess) return null;
    const layer = this.doc.getLayer(sess.layerId);
    if (!layer || !isPixelLayer(layer)) return null;
    const cDoc = this.transformedCornersDoc(layer);
    const c = cDoc.map((p) => this.docToScreen(p.x, p.y));
    const [nw, ne, se, sw] = c as [
      { x: number; y: number },
      { x: number; y: number },
      { x: number; y: number },
      { x: number; y: number },
    ];
    const mid = (a: { x: number; y: number }, b: { x: number; y: number }) => ({
      x: (a.x + b.x) / 2,
      y: (a.y + b.y) / 2,
    });
    const handles: { id: TransformHandleId; x: number; y: number }[] = [
      { id: "nw", ...nw },
      { id: "n", ...mid(nw, ne) },
      { id: "ne", ...ne },
      { id: "e", ...mid(ne, se) },
      { id: "se", ...se },
      { id: "s", ...mid(se, sw) },
      { id: "sw", ...sw },
      { id: "w", ...mid(sw, nw) },
    ];
    const minX = Math.min(nw.x, ne.x, se.x, sw.x);
    const minY = Math.min(nw.y, ne.y, se.y, sw.y);
    const maxX = Math.max(nw.x, ne.x, se.x, sw.x);
    const maxY = Math.max(nw.y, ne.y, se.y, sw.y);
    return {
      layerId: sess.layerId,
      bounds: { x: minX, y: minY, width: maxX - minX, height: maxY - minY },
      corners: c,
      handles,
      rotationDeg: sess.base.rotDeg,
      scaleX: sess.base.scaleX,
      scaleY: sess.base.scaleY,
      dx: sess.base.dx,
      dy: sess.base.dy,
    };
  }

  /**
   * Hit-test a screen-space point against the transform box. Returns the drag
   * mode + handle. Outside-but-near a corner = rotate; on a handle = scale;
   * inside the box = move; far outside = null (no-op / commit-on-click handled
   * by the pointer router).
   */
  private hitTestTransform(
    sx: number,
    sy: number,
  ): { mode: TransformDragMode; handle: TransformHandleId | null } | null {
    const st = this.getTransformState();
    if (!st) return null;
    const HANDLE = 9; // px hit radius for a handle
    const ROTATE = 22; // px outside a corner that still grabs rotate
    for (const h of st.handles) {
      if (Math.abs(sx - h.x) <= HANDLE && Math.abs(sy - h.y) <= HANDLE) {
        return { mode: "scale", handle: h.id };
      }
    }
    // Rotate zone: just outside a corner.
    const corners: TransformHandleId[] = ["nw", "ne", "se", "sw"];
    for (const id of corners) {
      const h = st.handles.find((x) => x.id === id)!;
      const d = Math.hypot(sx - h.x, sy - h.y);
      if (d > HANDLE && d <= HANDLE + ROTATE) return { mode: "rotate", handle: id };
    }
    // Inside the (rotated) quad → move. Point-in-polygon over the 4 corners.
    if (pointInQuad(sx, sy, st.corners)) return { mode: "move", handle: null };
    return null;
  }

  /**
   * Apply an explicit transform delta (UI escape hatch — the pointer router uses
   * the internal math, but the UI may call this for keyboard nudges etc.).
   */
  setTransform(patch: Partial<TransformState>): void {
    const sess = this.transformSession;
    if (!sess) return;
    sess.base = { ...sess.base, ...patch };
    this.markDirty();
    this.emit();
  }

  /**
   * Advance the live transform from a drag. `g.start` is the transform state at
   * drag-start; `doc` is the current pointer in doc px. Move adds the doc delta;
   * scale projects the pointer onto the box axes from the opposite handle as a
   * fixed pivot; rotate uses the angle about the box center. Shift keeps aspect
   * (scale) / 15° snaps (rotate).
   */
  private updateTransformDrag(
    g: { mode: TransformDragMode; startDoc: { x: number; y: number }; start: TransformState; handle: TransformHandleId | null },
    doc: { x: number; y: number },
    shift: boolean,
  ): void {
    const sess = this.transformSession!;
    const b = sess.baseBounds;
    const dxDoc = doc.x - g.startDoc.x;
    const dyDoc = doc.y - g.startDoc.y;

    if (g.mode === "move") {
      let ndx = g.start.dx + dxDoc;
      let ndy = g.start.dy + dyDoc;
      // Snap the transformed footprint's bounding box (translated by the new
      // delta) to guides/grid/canvas bounds/center.
      if (this.snapEnabled) {
        const snapped = this.snapMovedBox(b.x + ndx, b.y + ndy, b.width, b.height, 8);
        ndx += snapped.x - (b.x + ndx);
        ndy += snapped.y - (b.y + ndy);
      }
      sess.base = { ...g.start, dx: ndx, dy: ndy };
      return;
    }

    if (g.mode === "rotate") {
      const cx = b.x + b.width / 2 + g.start.dx;
      const cy = b.y + b.height / 2 + g.start.dy;
      const a0 = Math.atan2(g.startDoc.y - cy, g.startDoc.x - cx);
      const a1 = Math.atan2(doc.y - cy, doc.x - cx);
      let deg = g.start.rotDeg + ((a1 - a0) * 180) / Math.PI;
      if (shift) deg = Math.round(deg / 15) * 15;
      sess.base = { ...g.start, rotDeg: deg };
      return;
    }

    // scale: convert the doc-space drag delta into the box's UNROTATED local
    // axes (so handles behave intuitively even when rotated), scaling about the
    // box center. The delta along each axis grows/shrinks that dimension.
    const rad = (g.start.rotDeg * Math.PI) / 180;
    const cos = Math.cos(rad);
    const sin = Math.sin(rad);
    // Rotate the doc delta into local (unrotated) space.
    const localDx = dxDoc * cos + dyDoc * sin;
    const localDy = -dxDoc * sin + dyDoc * cos;
    const h = g.handle ?? "se";
    const right = h.includes("e");
    const left = h.includes("w");
    const bottom = h.includes("s");
    const top = h.includes("n");
    // Scaling about the center: moving a handle by d changes the half-extent by
    // d, i.e. the full extent by 2*d → scale factor delta = 2*d / extent.
    let sx = g.start.scaleX;
    let sy = g.start.scaleY;
    const baseW = b.width || 1;
    const baseH = b.height || 1;
    if (right) sx = g.start.scaleX + (2 * localDx) / baseW;
    else if (left) sx = g.start.scaleX - (2 * localDx) / baseW;
    if (bottom) sy = g.start.scaleY + (2 * localDy) / baseH;
    else if (top) sy = g.start.scaleY - (2 * localDy) / baseH;
    if (shift) {
      // Keep aspect: use the larger relative change for both axes.
      const corner = (left || right) && (top || bottom);
      if (corner) {
        const f = Math.abs(sx / (g.start.scaleX || 1)) >= Math.abs(sy / (g.start.scaleY || 1))
          ? sx / (g.start.scaleX || 1)
          : sy / (g.start.scaleY || 1);
        sx = g.start.scaleX * f;
        sy = g.start.scaleY * f;
      }
    }
    // Clamp to avoid collapse/flip jitter.
    const MIN = 0.02;
    if (Math.abs(sx) < MIN) sx = Math.sign(sx || 1) * MIN;
    if (Math.abs(sy) < MIN) sy = Math.sign(sy || 1) * MIN;
    sess.base = { ...g.start, scaleX: sx, scaleY: sy };
  }

  /**
   * Commit the active transform: resample the layer's pixels through the live
   * transform into a NEW source at the transformed bounds (GPU pass + RGBA8
   * readback), replaceSource + reposition. ONE undo step. For text layers this
   * also flattens them to raster pixels (the typographic params are replaced by
   * baked pixels — a future nicety would keep them editable).
   */
  commitTransform(): void {
    const sess = this.transformSession;
    const r = this.renderer;
    if (!sess || !r) {
      this.transformSession = null;
      this.markDirty();
      this.emit();
      return;
    }
    const layer = this.doc.getLayer(sess.layerId);
    if (!layer || !isPixelLayer(layer)) {
      this.transformSession = null;
      this.markDirty();
      this.emit();
      return;
    }
    // Identity transform: nothing to bake.
    const t = sess.base;
    const identity =
      t.dx === 0 && t.dy === 0 && t.scaleX === 1 && t.scaleY === 1 && t.rotDeg === 0;
    if (identity) {
      this.transformSession = null;
      this.markDirty();
      this.emit();
      return;
    }

    if (layer.kind === "text") this.ensureTextRasterized(layer);
    const tex = this.resolveTexture(layer.id);
    if (!tex) {
      this.transformSession = null;
      this.markDirty();
      this.emit();
      return;
    }

    // New bounds = integer AABB of the transformed corners.
    const cDoc = this.transformedCornersDoc(layer);
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const p of cDoc) {
      if (p.x < minX) minX = p.x;
      if (p.y < minY) minY = p.y;
      if (p.x > maxX) maxX = p.x;
      if (p.y > maxY) maxY = p.y;
    }
    const nx = Math.floor(minX);
    const ny = Math.floor(minY);
    const nw = Math.max(1, Math.ceil(maxX) - nx);
    const nh = Math.max(1, Math.ceil(maxY) - ny);

    const gl = r.gl;
    const target = r.createRGBA8Target(nw, nh);
    gl.bindFramebuffer(gl.FRAMEBUFFER, target.fbo);
    gl.viewport(0, 0, nw, nh);
    gl.disable(gl.BLEND);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    const prog = this.normalBlendProgram!;
    gl.useProgram(prog);
    // Map the transformed layer footprint (doc px) into the new target's clip,
    // offsetting by the new origin so the AABB maps to [0,nw]x[0,nh].
    const pixToClip = m3.pixelToClip(nw, nh);
    const docModel = this.layerModelMatrix(layer); // unit quad -> doc px (with xform)
    const offset = m3.translation(-nx, -ny);
    const transform = m3.multiply(pixToClip, m3.multiply(offset, docModel));
    gl.uniformMatrix3fv(gl.getUniformLocation(prog, "u_transform"), false, transform);
    gl.uniform1f(gl.getUniformLocation(prog, "u_opacity"), 1);
    gl.uniform1i(gl.getUniformLocation(prog, "u_tex"), 0);
    gl.uniform1i(gl.getUniformLocation(prog, "u_srgbSource"), tex.srgb ? 0 : 1);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, tex.tex);
    r.drawQuad();

    const rawLinear = r.readPixels(target, 0, 0, nw, nh);
    r.deleteFramebuffer(target);
    // normalBlendProgram outputs premultiplied LINEAR into an RGBA8 target; the
    // layer sources are straight sRGB. Un-premultiply + sRGB-encode to match.
    const out = new Uint8ClampedArray(nw * nh * 4);
    for (let y = 0; y < nh; y++) {
      const srcRow = (nh - 1 - y) * nw * 4; // GL readback is bottom-up
      const dstRow = y * nw * 4;
      for (let x = 0; x < nw * 4; x += 4) {
        const a = (rawLinear[srcRow + x + 3] ?? 0) / 255;
        const inv = a > 1e-4 ? 1 / a : 0;
        for (let ch = 0; ch < 3; ch++) {
          const lin = ((rawLinear[srcRow + x + ch] ?? 0) / 255) * inv;
          out[dstRow + x + ch] = Math.round(linearToSrgb(lin) * 255);
        }
        out[dstRow + x + 3] = rawLinear[srcRow + x + 3] ?? 0;
      }
    }
    const newSource = new ImageData(out, nw, nh);

    const id = layer.id;
    const wasText = layer.kind === "text";
    const prevTextParams = wasText ? this.doc.getTextLayerParams(id) : null;
    const prevSource = (layer as PixelLayer).source;
    const prevPos = { x: layer.x, y: layer.y };
    const prevW = layer.width;
    const prevH = layer.height;

    const apply = () => {
      if (wasText) this.convertTextToRaster(id, newSource, nx, ny);
      else {
        this.doc.replaceSource(id, newSource);
        this.doc.setPosition(id, nx, ny);
      }
      this.textures.delete(id);
    };
    const revert = () => {
      if (wasText && prevTextParams) {
        // Re-create the text layer in place (revert raster→text).
        this.restoreTextLayer(id, prevTextParams, prevSource, prevPos, prevW, prevH);
      } else if (prevSource) {
        this.doc.replaceSource(id, prevSource);
        this.doc.setPosition(id, prevPos.x, prevPos.y);
      }
      this.textures.delete(id);
    };

    this.transformSession = null;
    apply();
    this.history.push({
      label: "Free Transform",
      bytes: nw * nh * 4,
      undo: revert,
      redo: apply,
    });
    this.markDirty();
    this.emit();
  }

  /** Discard the active transform session (revert to the layer's original). */
  cancelTransform(): void {
    if (!this.transformSession) return;
    this.transformSession = null;
    this.markDirty();
    this.emit();
  }

  // ════════════════════════════════════════════════════════
  //  CROP
  // ════════════════════════════════════════════════════════
  /**
   * Begin a crop session. The initial rect defaults to the whole document; the
   * user drags edges/corners (engine math) and the overlay draws the rect +
   * rule-of-thirds. Switches the active tool to 'crop'.
   */
  beginCrop(): void {
    this.cropSession = {
      rect: { x: 0, y: 0, width: this.doc.width, height: this.doc.height },
    };
    toolStore.setActive("crop");
    this.markDirty();
    this.emit();
  }

  /** Whether a crop session is active. */
  isCropping(): boolean {
    return this.cropSession !== null;
  }

  /**
   * Crop state for the UI overlay: the rect in SCREEN px (so the overlay can
   * draw it + rule-of-thirds lines + the darkened outside region). Null when no
   * session is active.
   */
  getCropState(): {
    rect: { x: number; y: number; width: number; height: number };
    docRect: Rect;
  } | null {
    const cs = this.cropSession;
    if (!cs) return null;
    const tl = this.docToScreen(cs.rect.x, cs.rect.y);
    const br = this.docToScreen(cs.rect.x + cs.rect.width, cs.rect.y + cs.rect.height);
    return {
      rect: { x: tl.x, y: tl.y, width: br.x - tl.x, height: br.y - tl.y },
      docRect: { ...cs.rect },
    };
  }

  /** Hit-test a screen point against the crop rect; returns the drag mode. */
  private hitTestCrop(sx: number, sy: number): CropDragMode {
    const cs = this.cropSession;
    if (!cs) return "new";
    const tl = this.docToScreen(cs.rect.x, cs.rect.y);
    const br = this.docToScreen(cs.rect.x + cs.rect.width, cs.rect.y + cs.rect.height);
    const E = 8;
    const nearL = Math.abs(sx - tl.x) <= E;
    const nearR = Math.abs(sx - br.x) <= E;
    const nearT = Math.abs(sy - tl.y) <= E;
    const nearB = Math.abs(sy - br.y) <= E;
    const insideX = sx >= tl.x - E && sx <= br.x + E;
    const insideY = sy >= tl.y - E && sy <= br.y + E;
    if (insideX && insideY) {
      if (nearT && nearL) return "nw";
      if (nearT && nearR) return "ne";
      if (nearB && nearL) return "sw";
      if (nearB && nearR) return "se";
      if (nearT) return "n";
      if (nearB) return "s";
      if (nearL) return "w";
      if (nearR) return "e";
      if (sx > tl.x && sx < br.x && sy > tl.y && sy < br.y) return "move";
    }
    return "new";
  }

  /** Advance the live crop rect from a drag (doc px). */
  private updateCropDrag(
    g: { mode: CropDragMode; startDoc: { x: number; y: number }; startRect: Rect },
    doc: { x: number; y: number },
  ): void {
    const cs = this.cropSession;
    if (!cs) return;
    const dx = doc.x - g.startDoc.x;
    const dy = doc.y - g.startDoc.y;
    const s = g.startRect;
    let x0 = s.x;
    let y0 = s.y;
    let x1 = s.x + s.width;
    let y1 = s.y + s.height;

    if (g.mode === "new") {
      x0 = Math.min(g.startDoc.x, doc.x);
      y0 = Math.min(g.startDoc.y, doc.y);
      x1 = Math.max(g.startDoc.x, doc.x);
      y1 = Math.max(g.startDoc.y, doc.y);
    } else if (g.mode === "move") {
      x0 += dx; x1 += dx; y0 += dy; y1 += dy;
    } else {
      if (g.mode.includes("w")) x0 = s.x + dx;
      if (g.mode.includes("e")) x1 = s.x + s.width + dx;
      if (g.mode.includes("n")) y0 = s.y + dy;
      if (g.mode.includes("s")) y1 = s.y + s.height + dy;
    }
    // Normalize (allow dragging an edge past the opposite one).
    const nx0 = Math.min(x0, x1);
    const ny0 = Math.min(y0, y1);
    const nx1 = Math.max(x0, x1);
    const ny1 = Math.max(y0, y1);
    cs.rect = { x: nx0, y: ny0, width: Math.max(1, nx1 - nx0), height: Math.max(1, ny1 - ny0) };
  }

  /**
   * Commit the crop: resize the document to the crop rect, offset ALL layers by
   * (-rect.x, -rect.y), resize the selection buffer. ONE undo step (restores the
   * doc size + every layer's position). Adjustment layers cover the doc so they
   * need no offset.
   */
  commitCrop(): void {
    const cs = this.cropSession;
    if (!cs) return;
    const rect = {
      x: Math.round(cs.rect.x),
      y: Math.round(cs.rect.y),
      width: Math.max(1, Math.round(cs.rect.width)),
      height: Math.max(1, Math.round(cs.rect.height)),
    };
    this.cropSession = null;

    const prevW = this.doc.width;
    const prevH = this.doc.height;
    // Snapshot every pixel layer's position for undo.
    const prevPositions: { id: LayerId; x: number; y: number }[] = [];
    for (const id of this.doc.orderBottomToTop()) {
      const l = this.doc.getLayer(id);
      if (l && isPixelLayer(l)) prevPositions.push({ id, x: l.x, y: l.y });
    }
    // Adjustment-layer masks are full-document, so they must be cropped to the
    // new doc bounds too (raster/text masks are layer-local and ride along with
    // their layer's offset). Snapshot the old + new buffers for one undo step.
    const adjMaskEdits: {
      id: LayerId;
      prev: { data: Uint8Array; w: number; h: number };
      next: { data: Uint8Array; w: number; h: number };
    }[] = [];
    for (const id of this.doc.orderBottomToTop()) {
      const l = this.doc.getLayer(id);
      if (l && l.kind === "adjustment" && l.mask) {
        const prev = { data: l.mask.data.slice(), w: l.mask.width, h: l.mask.height };
        const next = {
          data: cropMaskBuffer(prev.data, prev.w, prev.h, rect),
          w: rect.width,
          h: rect.height,
        };
        adjMaskEdits.push({ id, prev, next });
      }
    }
    const setMask = (id: LayerId, m: { data: Uint8Array; w: number; h: number }) => {
      const l = this.doc.getLayer(id);
      if (l?.mask) {
        l.mask.data = m.data.slice();
        l.mask.width = m.w;
        l.mask.height = m.h;
        l.mask.version += 1;
        this.maskTextures.delete(id);
      }
    };

    const apply = () => {
      this.doc.width = rect.width;
      this.doc.height = rect.height;
      for (const p of prevPositions) {
        const l = this.doc.getLayer(p.id);
        if (l && isPixelLayer(l)) this.doc.setPosition(p.id, p.x - rect.x, p.y - rect.y);
      }
      for (const e of adjMaskEdits) setMask(e.id, e.next);
      this.selection?.resize(rect.width, rect.height);
      this.snapshotCache = this.doc.snapshot();
      this.markDirty();
      this.emit();
    };
    const revert = () => {
      this.doc.width = prevW;
      this.doc.height = prevH;
      for (const p of prevPositions) {
        const l = this.doc.getLayer(p.id);
        if (l && isPixelLayer(l)) this.doc.setPosition(p.id, p.x, p.y);
      }
      for (const e of adjMaskEdits) setMask(e.id, e.prev);
      this.selection?.resize(prevW, prevH);
      this.snapshotCache = this.doc.snapshot();
      this.markDirty();
      this.emit();
    };

    apply();
    this.history.push({
      label: "Crop",
      bytes: 0,
      undo: revert,
      redo: apply,
    });
  }

  /** Discard the active crop session. */
  cancelCrop(): void {
    if (!this.cropSession) return;
    this.cropSession = null;
    this.markDirty();
    this.emit();
  }

  // ════════════════════════════════════════════════════════
  //  TEXT / TYPE LAYERS
  // ════════════════════════════════════════════════════════
  /**
   * Create a text layer at a document point and select it for editing. Returns
   * the new layer id. The UI watches getActiveTextEditing() to open an overlay
   * <textarea>. One undo step (layer add).
   */
  addTextLayer(atDocX: number, atDocY: number, initialText = ""): LayerId {
    const ts = toolStore.get().text;
    const fg = toolStore.get().foreground;
    const id = this.doc.addTextLayer(atDocX, atDocY, {
      text: initialText,
      fontFamily: ts.fontFamily,
      fontSize: ts.fontSize,
      color: ts.color ?? { ...fg },
      align: ts.align,
      bold: ts.bold,
      italic: ts.italic,
      lineHeight: ts.lineHeight,
    });
    this.history.push(
      paramCommand(
        "Add text layer",
        () => {},
        () => this.doc.remove(id),
      ),
    );
    this.textEditing = { layerId: id };
    this.markDirty();
    this.emit();
    return id;
  }

  /**
   * Live-update a text layer's typographic params (re-rasterizes on next render
   * via the version bump). No per-keystroke undo; the caller records one step on
   * blur/commit via commitTextLayer.
   */
  updateTextLayer(id: LayerId, patch: TextLayerPatch): void {
    this.doc.updateTextLayer(id, patch);
    this.textures.delete(id); // drop stale GPU texture
    this.markDirty();
  }

  /** Record a single undo step for a text edit (prev/next full param sets). */
  commitTextLayer(id: LayerId, prev: TextLayerSnapshot, next: TextLayerSnapshot): void {
    const before = { ...prev, color: { ...prev.color } };
    const after = { ...next, color: { ...next.color } };
    this.doc.setTextLayerParams(id, after);
    this.textures.delete(id);
    this.history.push(
      paramCommand(
        "Edit text",
        () => {
          this.doc.setTextLayerParams(id, { ...after, color: { ...after.color } });
          this.textures.delete(id);
        },
        () => {
          this.doc.setTextLayerParams(id, { ...before, color: { ...before.color } });
          this.textures.delete(id);
        },
      ),
    );
    this.markDirty();
    this.emit();
  }

  /**
   * The text layer currently being edited (after creating/clicking with the type
   * tool), with its screen-space placement so the UI can position an overlay
   * <textarea>. Null when not editing.
   */
  getActiveTextEditing(): {
    layerId: LayerId;
    screenRect: { x: number; y: number; width: number; height: number };
    text: string;
    fontFamily: string;
    fontSize: number;
    color: RGBAColor;
    align: "left" | "center" | "right";
    bold: boolean;
    italic: boolean;
    lineHeight: number;
  } | null {
    const te = this.textEditing;
    if (!te) return null;
    const layer = this.doc.getLayer(te.layerId);
    if (!layer || layer.kind !== "text") {
      this.textEditing = null;
      return null;
    }
    this.ensureTextRasterized(layer);
    const tl = this.docToScreen(layer.x, layer.y);
    const scale = this.view.scale / this.dpr;
    return {
      layerId: layer.id,
      screenRect: {
        x: tl.x,
        y: tl.y,
        width: Math.max(40, layer.width * scale),
        height: Math.max(layer.fontSize * layer.lineHeight, layer.height) * scale,
      },
      text: layer.text,
      fontFamily: layer.fontFamily,
      fontSize: layer.fontSize,
      color: { ...layer.color },
      align: layer.align,
      bold: layer.bold,
      italic: layer.italic,
      lineHeight: layer.lineHeight,
    };
  }

  /** Open the type editor for an existing text layer (double-click flow). */
  beginEditText(id: LayerId): void {
    const layer = this.doc.getLayer(id);
    if (!layer || layer.kind !== "text") return;
    this.doc.setActive(id);
    this.textEditing = { layerId: id };
    toolStore.setActive("text");
    this.markDirty();
    this.emit();
  }

  /** Close the type editor (UI calls on blur / Esc / Enter-commit). */
  endEditText(): void {
    if (!this.textEditing) return;
    this.textEditing = null;
    this.markDirty();
    this.emit();
  }

  /**
   * Rasterize a text layer to an ImageData via an Offscreen/HTML 2D canvas when
   * its version changed since the last raster. Measures the text, sizes the
   * bitmap, draws each line with font/size/color/align/lineHeight, and stores it
   * back on the layer (source + width/height; x stays anchored, but the bitmap
   * may extend left for centered/right text — we keep x at the layer origin and
   * draw within [0,width]).
   */
  private ensureTextRasterized(layer: TextLayer): void {
    const last = this.textRasterVersion.get(layer.id);
    if (last === layer.version && layer.source) return;

    const fontStyle = `${layer.italic ? "italic " : ""}${layer.bold ? "700 " : "400 "}${layer.fontSize}px ${layer.fontFamily}`;
    const lineH = Math.max(1, Math.round(layer.fontSize * layer.lineHeight));
    const lines = (layer.text.length ? layer.text : " ").split("\n");

    // Measure on a scratch context.
    const measureCv = makeCanvas(8, 8);
    const mctx = get2d(measureCv);
    mctx.font = fontStyle;
    let maxW = 1;
    for (const ln of lines) {
      const w = mctx.measureText(ln.length ? ln : " ").width;
      if (w > maxW) maxW = w;
    }
    // Pad for descenders / italic overhang.
    const padX = Math.ceil(layer.fontSize * 0.25);
    const padY = Math.ceil(layer.fontSize * 0.3);
    const W = Math.max(1, Math.ceil(maxW) + padX * 2);
    const H = Math.max(1, lines.length * lineH + padY * 2);

    const cv = makeCanvas(W, H);
    const ctx = get2d(cv);
    ctx.clearRect(0, 0, W, H);
    ctx.font = fontStyle;
    ctx.textBaseline = "alphabetic";
    ctx.textAlign = layer.align;
    const col = layer.color;
    ctx.fillStyle = `rgba(${Math.round(col.r * 255)},${Math.round(col.g * 255)},${Math.round(col.b * 255)},${col.a})`;
    let anchorX = padX;
    if (layer.align === "center") anchorX = W / 2;
    else if (layer.align === "right") anchorX = W - padX;
    // Baseline of line i: padY + ascent + i*lineH. Approximate ascent ~0.8em.
    const ascent = layer.fontSize * 0.8;
    for (let i = 0; i < lines.length; i++) {
      const baseY = padY + ascent + i * lineH;
      ctx.fillText(lines[i] ?? "", anchorX, baseY);
    }

    const img = ctx.getImageData(0, 0, W, H);
    const source = new ImageData(
      new Uint8ClampedArray(img.data),
      W,
      H,
    );
    this.doc.setTextRaster(layer.id, source, layer.x, layer.y);
    this.textRasterVersion.set(layer.id, layer.version);
    this.textures.delete(layer.id);
  }

  /** Convert a text layer to a plain raster layer in place (transform-commit). */
  private convertTextToRaster(
    id: LayerId,
    source: ImageData,
    x: number,
    y: number,
  ): void {
    // Remove the text layer, recreate a raster layer with the same id slot is
    // not possible (ids are generated); instead we mutate via Document by
    // replacing the node. Document has no "convert" op, so we remove + re-add
    // would change id. To keep id stable + undo simple, store the baked source
    // ON the text layer and flip a flag — but the model has no such flag.
    // Simplest coherent approach: keep it a text layer but stamp the baked
    // pixels as its source and clear the text so re-rasterize is a no-op.
    // However that loses blendMode/opacity continuity. Instead: replace the
    // node wholesale through a dedicated Document path.
    this.doc.bakeTextToRaster(id, source, x, y);
    this.textRasterVersion.delete(id);
    this.textures.delete(id);
  }

  /** Restore a baked-raster layer back to a text layer (transform undo). */
  private restoreTextLayer(
    id: LayerId,
    params: TextLayerSnapshot,
    _prevSource: ImageBitmap | ImageData | undefined,
    pos: { x: number; y: number },
    _w: number,
    _h: number,
  ): void {
    this.doc.unbakeTextFromRaster(id, params, pos.x, pos.y);
    this.textRasterVersion.delete(id);
    this.textures.delete(id);
  }

  // ════════════════════════════════════════════════════════
  //  SHAPE TOOL
  // ════════════════════════════════════════════════════════
  /** Live shape drag (doc px) for the overlay preview, or null. */
  getLiveShape(): { kind: ShapeKind; from: { x: number; y: number }; to: { x: number; y: number } } | null {
    return this.gesture.kind === "shape" ? this.liveShape : null;
  }

  // ════════════════════════════════════════════════════════
  //  VECTOR PATHS / PEN TOOL
  // ════════════════════════════════════════════════════════
  /**
   * Pen pointerdown: route a click into the live vector path.
   *   - clicking the FIRST anchor of the open subpath closes it;
   *   - otherwise a corner anchor is placed at the point (a following drag pulls
   *     its out handle, making it smooth — handled in handlePointerMove).
   * Screen-px hit radius converts to doc px via the current view scale.
   */
  private penPointerDown(doc: { x: number; y: number }, _e: PointerEvent): void {
    const hitDoc = 8 / Math.max(1e-4, this.view.scale); // ~8 screen px
    // Close the subpath when clicking near its first anchor (>=2 anchors placed).
    if (this.paths.liveHasAnchors) {
      const first = this.paths.liveFirstAnchor();
      const last = this.paths.liveLastAnchor();
      if (
        first &&
        last &&
        first !== last &&
        Math.hypot(doc.x - first.x, doc.y - first.y) <= hitDoc
      ) {
        this.paths.closeLive();
        // A closed subpath ends this subpath; finish the whole path so a fresh
        // pen click starts a new one (v1 single-subpath-per-gesture behaviour).
        this.paths.finishLive();
        this.gesture = { kind: "none" };
        this.markDirty();
        this.emit();
        return;
      }
    }
    // Place a corner anchor; the move handler may upgrade it to smooth on drag.
    this.paths.beginAnchor(cornerAnchor(doc.x, doc.y));
    this.gesture = { kind: "pen", anchorPt: { x: doc.x, y: doc.y } };
    this.markDirty();
    this.emit();
  }

  /**
   * The in-progress (live) path + active committed path, in DOC px, for the UI
   * overlay to render the curve, anchors and handles (it maps via
   * getViewTransform). Null when there is no live or active path.
   */
  getActivePath(): PathDescription | null {
    return this.paths.getActivePath();
  }
  /** All committed paths (serializable, doc px). */
  getPaths(): PathDescription[] {
    return this.paths.getPaths();
  }
  /** Whether the pen tool is mid-draw (UI may show "Enter to finish"). */
  isDrawingPath(): boolean {
    return this.paths.isDrawing;
  }

  // ── path + guide/grid persistence (used by serialize.ts) ──
  /** All committed paths as plain serializable objects (doc px). */
  serializePaths(): Path[] {
    return this.paths.getPaths().map((p) => ({
      id: p.id,
      name: p.name,
      subpaths: p.subpaths,
    }));
  }
  /** Restore the committed path list (project load). */
  setPathsSerialized(paths: Path[]): void {
    this.paths.setPaths(paths);
    this.markDirty();
    this.emit();
  }
  /** Snapshot guides + grid + ruler/snap toggles for project save. */
  serializeViewExtras(): {
    guides: Guide[];
    grid: GridState;
    rulersVisible: boolean;
    snapEnabled: boolean;
  } {
    return {
      guides: this.getGuides(),
      grid: this.getGrid(),
      rulersVisible: this.rulersVisible,
      snapEnabled: this.snapEnabled,
    };
  }
  /** Restore guides + grid + ruler/snap toggles (project load). */
  setViewExtras(extras: {
    guides?: Guide[];
    grid?: GridState;
    rulersVisible?: boolean;
    snapEnabled?: boolean;
  }): void {
    if (extras.guides) {
      this.guides = extras.guides.map((g) => ({ ...g }));
      // Keep the id counter ahead of any restored numeric ids.
      for (const g of this.guides) {
        const n = Number(String(g.id).replace(/[^0-9]/g, ""));
        if (Number.isFinite(n) && n > this.guideSeq) this.guideSeq = n;
      }
    }
    if (extras.grid) this.grid = { ...extras.grid };
    if (typeof extras.rulersVisible === "boolean") this.rulersVisible = extras.rulersVisible;
    if (typeof extras.snapEnabled === "boolean") this.snapEnabled = extras.snapEnabled;
    this.markDirty();
    this.emit();
  }

  /**
   * Rasterize a closed path into the selection. Uses the path's closed subpaths
   * (fill rule nonzero/evenodd), drawn on a 2D canvas at doc resolution, then
   * combined into the selection with `op` (default replace) + the tool feather.
   * No-op if the path has no closed region.
   */
  makePathSelection(
    pathId?: LayerId,
    op: SelectionOp = "replace",
    rule: FillRule = "nonzero",
  ): void {
    const sel = this.selection;
    const path = this.paths.resolve(pathId);
    if (!sel || !path || !pathHasClosedRegion(path)) return;
    const dw = this.doc.width;
    const dh = this.doc.height;
    const cv = makeCanvas(dw, dh);
    const ctx = get2d(cv) as CanvasRenderingContext2D;
    ctx.clearRect(0, 0, dw, dh);
    ctx.fillStyle = "#fff";
    ctx.beginPath();
    tracePath(ctx, path as Path, 0, 0, /*onlyClosed*/ true);
    ctx.fill(rule);
    const img = ctx.getImageData(0, 0, dw, dh);
    // Pack the red channel into an R8 buffer (canvas row 0 = doc top, matching
    // the selection's stored orientation).
    const r8 = new Uint8Array(dw * dh);
    for (let i = 0; i < r8.length; i++) r8[i] = img.data[i * 4]!;
    sel.combineFromBuffer(r8, op, toolStore.get().feather);
    this.markDirty();
    this.emit();
  }

  /**
   * Fill the closed region(s) of a path with a color (default foreground) on the
   * active raster layer, as one undo step. No-op if no closed region / no raster
   * layer. The path is rendered in the layer's local space (doc - layer origin).
   */
  fillPath(pathId?: LayerId, color?: RGBAColor, rule: FillRule = "nonzero"): void {
    const path = this.paths.resolve(pathId);
    const id = this.doc.getActiveLayerId();
    if (!path || !pathHasClosedRegion(path) || !id) return;
    const layer = this.doc.getLayer(id);
    if (!layer || layer.kind !== "raster") return;
    const fill = color ?? toolStore.get().foreground;
    this.compositePathOntoLayer(layer, (ctx, ox, oy) => {
      ctx.fillStyle = cssColor(fill);
      ctx.beginPath();
      tracePath(ctx, path as Path, ox, oy, /*onlyClosed*/ true);
      ctx.fill(rule);
    }, "Fill path");
  }

  /**
   * Stroke a path's outline onto the active raster layer (default foreground,
   * width 2 doc px), as one undo step. Strokes ALL subpaths (open + closed).
   */
  strokePath(
    pathId?: LayerId,
    opts?: { width?: number; color?: RGBAColor },
  ): void {
    const path = this.paths.resolve(pathId);
    const id = this.doc.getActiveLayerId();
    if (!path || !id) return;
    const layer = this.doc.getLayer(id);
    if (!layer || layer.kind !== "raster") return;
    const width = Math.max(0.25, opts?.width ?? 2);
    const color = opts?.color ?? toolStore.get().foreground;
    this.compositePathOntoLayer(layer, (ctx, ox, oy) => {
      ctx.strokeStyle = cssColor(color);
      ctx.lineWidth = width;
      ctx.lineJoin = "round";
      ctx.lineCap = "round";
      ctx.beginPath();
      tracePath(ctx, path as Path, ox, oy, /*onlyClosed*/ false);
      ctx.stroke();
    }, "Stroke path");
  }

  /** Delete a path (or the active one). One UI emit; no undo step (cheap). */
  deletePath(pathId?: LayerId): void {
    if (this.paths.deletePath(pathId)) {
      this.markDirty();
      this.emit();
    }
  }
  /** Discard the in-progress live path (Esc equivalent for the UI). */
  clearActivePath(): void {
    this.paths.clearLive();
    this.markDirty();
    this.emit();
  }

  /**
   * Composite a 2D-canvas draw (in the layer's local space) over the active
   * raster layer's existing pixels and replace the layer source, recording one
   * undo step. The `draw` callback paints into a layer-sized canvas already
   * seeded with the current pixels; `ox,oy` translate doc px -> layer-local px.
   */
  private compositePathOntoLayer(
    layer: RasterLayer,
    draw: (
      ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
      ox: number,
      oy: number,
    ) => void,
    label: string,
  ): void {
    const w = layer.width;
    const h = layer.height;
    const cv = makeCanvas(w, h);
    const ctx = get2d(cv);
    ctx.clearRect(0, 0, w, h);
    // Seed with the layer's current pixels (straight alpha).
    const src = layer.source;
    if (typeof ImageData !== "undefined" && src instanceof ImageData) {
      ctx.putImageData(src, 0, 0);
    } else if (src) {
      ctx.drawImage(src as ImageBitmap, 0, 0);
    }
    // Draw the path in layer-local space (doc - layer origin).
    draw(ctx, layer.x, layer.y);
    const img = ctx.getImageData(0, 0, w, h);
    const newSource = new ImageData(new Uint8ClampedArray(img.data), w, h);
    const lid = layer.id;
    const prevSource = src;
    const apply = () => {
      this.doc.replaceSource(lid, newSource);
      this.textures.delete(lid);
    };
    const revert = () => {
      this.doc.replaceSource(lid, prevSource);
      this.textures.delete(lid);
    };
    apply();
    this.history.push({
      label,
      bytes: w * h * 4,
      undo: revert,
      redo: apply,
    });
    this.markDirty();
    this.emit();
  }

  /**
   * Rasterize a shape (rect/ellipse/line) defined by two doc-space points into a
   * NEW raster layer, filled with the shape fill (or foreground) + optional
   * stroke. ONE undo step (the layer add). Returns the new layer id, or null for
   * a degenerate drag.
   */
  commitShape(
    kind: ShapeKind,
    from: { x: number; y: number },
    to: { x: number; y: number },
  ): LayerId | null {
    const ts = toolStore.get();
    const fill = ts.shape.fill ?? ts.foreground;
    const stroke = ts.shape.stroke;
    const strokeW = Math.max(0, stroke.width);

    // Bitmap bounds = AABB of the drag, padded for the stroke. For a line the
    // "fill" is the stroke (use a sensible default width when 0).
    const lineW = kind === "line" ? Math.max(1, strokeW || Math.max(2, ts.brush.size * 0.1)) : strokeW;
    const pad = Math.ceil((kind === "line" ? lineW : strokeW) / 2) + 1;
    const minX = Math.min(from.x, to.x) - pad;
    const minY = Math.min(from.y, to.y) - pad;
    const maxX = Math.max(from.x, to.x) + pad;
    const maxY = Math.max(from.y, to.y) + pad;
    const ox = Math.floor(minX);
    const oy = Math.floor(minY);
    const W = Math.max(1, Math.ceil(maxX) - ox);
    const H = Math.max(1, Math.ceil(maxY) - oy);
    if (W < 1 || H < 1) return null;
    if (kind !== "line" && (Math.abs(to.x - from.x) < 1 || Math.abs(to.y - from.y) < 1)) {
      return null;
    }
    if (kind === "line" && Math.hypot(to.x - from.x, to.y - from.y) < 1) return null;

    const cv = makeCanvas(W, H);
    const ctx = get2d(cv);
    ctx.clearRect(0, 0, W, H);
    const css = (c: RGBAColor) =>
      `rgba(${Math.round(c.r * 255)},${Math.round(c.g * 255)},${Math.round(c.b * 255)},${c.a})`;
    // Local coords: doc - origin.
    const lx = (x: number) => x - ox;
    const ly = (y: number) => y - oy;

    if (kind === "rect") {
      const x0 = lx(Math.min(from.x, to.x));
      const y0 = ly(Math.min(from.y, to.y));
      const w = Math.abs(to.x - from.x);
      const h = Math.abs(to.y - from.y);
      ctx.fillStyle = css(fill);
      ctx.fillRect(x0, y0, w, h);
      if (strokeW > 0) {
        ctx.lineWidth = strokeW;
        ctx.strokeStyle = css(stroke.color);
        ctx.strokeRect(x0, y0, w, h);
      }
    } else if (kind === "ellipse") {
      const cx = lx((from.x + to.x) / 2);
      const cy = ly((from.y + to.y) / 2);
      const rx = Math.abs(to.x - from.x) / 2;
      const ry = Math.abs(to.y - from.y) / 2;
      ctx.beginPath();
      ctx.ellipse(cx, cy, Math.max(0.5, rx), Math.max(0.5, ry), 0, 0, Math.PI * 2);
      ctx.fillStyle = css(fill);
      ctx.fill();
      if (strokeW > 0) {
        ctx.lineWidth = strokeW;
        ctx.strokeStyle = css(stroke.color);
        ctx.stroke();
      }
    } else {
      // line: stroke from→to with the stroke color (fallback to fill color).
      ctx.beginPath();
      ctx.moveTo(lx(from.x), ly(from.y));
      ctx.lineTo(lx(to.x), ly(to.y));
      ctx.lineCap = "round";
      ctx.lineWidth = lineW;
      ctx.strokeStyle = css(strokeW > 0 ? stroke.color : fill);
      ctx.stroke();
    }

    const img = ctx.getImageData(0, 0, W, H);
    const source = new ImageData(new Uint8ClampedArray(img.data), W, H);
    const id = this.doc.addRasterLayer(source, "Shape", { x: ox, y: oy });
    this.history.push(
      paramCommand(
        "Add shape",
        () => {},
        () => this.doc.remove(id),
      ),
    );
    this.markDirty();
    this.emit();
    return id;
  }

  // ── export support (used by export.ts; unchanged surface) ──
  getRenderer(): WebGL2Renderer | null {
    return this.renderer;
  }
  getBlendProgram(): WebGLProgram | null {
    // export.ts composites with fixed-function NORMAL blend; hand it the
    // dedicated normal program (uniforms: u_transform/u_opacity/u_tex/u_srgbSource).
    return this.normalBlendProgram;
  }
  resolveTexturePublic(id: LayerId): TextureHandle | null {
    return this.resolveTexture(id);
  }

  // ════════════════════════════════════════════════════════
  //  PROJECT SAVE / LOAD (.aips)
  // ════════════════════════════════════════════════════════
  /** Serialize the whole project (layers/groups/effects/pixels) to an .aips Blob. */
  async saveProject(): Promise<Blob> {
    const { serializeDocument } = await import("./serialize");
    return serializeDocument(this);
  }

  /** Load a project from an .aips File/Blob/JSON, replacing the current document. */
  async loadProject(input: Blob | File | string): Promise<void> {
    const { deserializeDocument } = await import("./serialize");
    await deserializeDocument(this, input);
  }

  /**
   * After deserializeDocument rebuilds the Document: drop all GPU caches (so
   * textures / masks / LUTs re-resolve from the new sources), reset the text
   * rasterization cache, resize the selection to the new doc, clear history, and
   * re-render + re-snapshot.
   */
  reloadAfterDeserialize(): void {
    const r = this.renderer;
    this.textures.clear();
    this.maskTextures.clear();
    if (r) for (const e of this.adjustmentLUTs.values()) r.deleteTexture(e.tex);
    this.adjustmentLUTs.clear();
    this.textRasterVersion.clear();
    this.filterPreview = null;
    this.transformSession = null;
    this.cropSession = null;
    this.textEditing = null;
    // Paths + guides belong to the (now-replaced) document; deserialize restores
    // them after this via setPathsSerialized / setGuidesSerialized.
    this.paths.clearAll();
    this.guides = [];
    this.liveGuide = null;
    this.selection?.resize(this.doc.width, this.doc.height);
    this.selection?.clear();
    this.history.clear();
    this.snapshotCache = this.doc.snapshot();
    this.fitToScreen();
    this.markDirty();
    this.emit();
  }
}

// ── module-level helpers ──────────────────────────────────
/** Create a 2D drawing surface (OffscreenCanvas when available, else <canvas>). */
function makeCanvas(w: number, h: number): OffscreenCanvas | HTMLCanvasElement {
  if (typeof OffscreenCanvas !== "undefined") return new OffscreenCanvas(w, h);
  const cv = document.createElement("canvas");
  cv.width = w;
  cv.height = h;
  return cv;
}

/** Get a 2D context (sRGB) from a canvas built by makeCanvas. */
function get2d(
  cv: OffscreenCanvas | HTMLCanvasElement,
): CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D {
  const ctx = cv.getContext("2d", { colorSpace: "srgb" }) as
    | CanvasRenderingContext2D
    | OffscreenCanvasRenderingContext2D
    | null;
  if (!ctx) throw new Error("2D context unavailable");
  return ctx;
}

/** Format a straight-sRGB RGBAColor (0..1) as a CSS rgba() string. */
function cssColor(c: RGBAColor): string {
  return `rgba(${Math.round(c.r * 255)},${Math.round(c.g * 255)},${Math.round(c.b * 255)},${c.a})`;
}

/**
 * Crop a full-document R8 mask buffer (row-major, top-down, row 0 = doc top) to
 * a new rect. Pixels outside the old buffer default to 0 (hidden), matching the
 * convention that an unspecified mask region is masked out.
 */
function cropMaskBuffer(
  src: Uint8Array,
  srcW: number,
  srcH: number,
  rect: { x: number; y: number; width: number; height: number },
): Uint8Array {
  const out = new Uint8Array(rect.width * rect.height); // default 0
  for (let y = 0; y < rect.height; y++) {
    const sy = rect.y + y;
    if (sy < 0 || sy >= srcH) continue;
    for (let x = 0; x < rect.width; x++) {
      const sx = rect.x + x;
      if (sx < 0 || sx >= srcW) continue;
      out[y * rect.width + x] = src[sy * srcW + sx] ?? 0;
    }
  }
  return out;
}

/** Point-in-(convex)-quad test for the 4 transform corners (NW,NE,SE,SW). */
function pointInQuad(
  px: number,
  py: number,
  pts: { x: number; y: number }[],
): boolean {
  if (pts.length < 4) return false;
  let sign = 0;
  for (let i = 0; i < 4; i++) {
    const a = pts[i]!;
    const b = pts[(i + 1) % 4]!;
    const cross = (b.x - a.x) * (py - a.y) - (b.y - a.y) * (px - a.x);
    const s = cross > 0 ? 1 : cross < 0 ? -1 : 0;
    if (s !== 0) {
      if (sign === 0) sign = s;
      else if (s !== sign) return false;
    }
  }
  return true;
}

/**
 * Sensible defaults per layer-effect type, used when updateLayerEffect creates
 * an effect from a partial patch. Colors are straight sRGB 0..1.
 */
const DEFAULT_EFFECTS: Record<LayerEffectType, Record<string, unknown>> = {
  dropShadow: {
    enabled: true,
    color: { r: 0, g: 0, b: 0, a: 1 },
    opacity: 0.5,
    angle: 135,
    distance: 8,
    size: 8,
    spread: 0,
  },
  innerShadow: {
    enabled: true,
    color: { r: 0, g: 0, b: 0, a: 1 },
    opacity: 0.5,
    angle: 135,
    distance: 6,
    size: 6,
  },
  stroke: {
    enabled: true,
    color: { r: 0, g: 0, b: 0, a: 1 },
    width: 3,
    position: "outside",
  },
  outerGlow: {
    enabled: true,
    color: { r: 1, g: 1, b: 0.6, a: 1 },
    opacity: 0.6,
    size: 12,
  },
  colorOverlay: {
    enabled: true,
    color: { r: 1, g: 0, b: 0, a: 1 },
    opacity: 1,
    blendMode: "normal",
  },
};

/** Undo labels per retouch mode. */
const RETOUCH_LABELS: Record<RetouchMode, string> = {
  clone: "Clone Stamp",
  heal: "Healing Brush",
  dodge: "Dodge",
  burn: "Burn",
  smudge: "Smudge",
  blur: "Blur",
  sharpen: "Sharpen",
};

/**
 * Cheap one-pass edge antialias for a binary 0/255 R8 mask. Border texels (a
 * selected texel adjacent to an unselected one, or vice-versa) are set to the
 * average of their 4-neighbourhood so the contour is smoother. Operates on a
 * copy of the input so the averaging isn't order-dependent.
 */
function antialiasMaskEdge(mask: Uint8Array, w: number, h: number): void {
  const src = mask.slice();
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      const c = src[i]!;
      const l = x > 0 ? src[i - 1]! : c;
      const rr = x < w - 1 ? src[i + 1]! : c;
      const u = y > 0 ? src[i - w]! : c;
      const d = y < h - 1 ? src[i + w]! : c;
      // Only soften texels on the boundary (a neighbour differs).
      if (l === c && rr === c && u === c && d === c) continue;
      mask[i] = Math.round((c + l + rr + u + d) / 5);
    }
  }
}

function linearToSrgb(c: number): number {
  if (c <= 0.0031308) return c * 12.92;
  return 1.055 * Math.pow(c, 1 / 2.4) - 0.055;
}
function srgbToLinearScalar(c: number): number {
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

/** Linearly interpolate the alpha channel across sorted gradient stops. */
function sampleGradientAlpha(stops: GradientStop[], t: number): number {
  if (stops.length === 0) return 1;
  if (t <= stops[0]!.pos) return stops[0]!.color.a;
  if (t >= stops[stops.length - 1]!.pos) return stops[stops.length - 1]!.color.a;
  for (let i = 0; i < stops.length - 1; i++) {
    const a = stops[i]!;
    const b = stops[i + 1]!;
    if (t >= a.pos && t <= b.pos) {
      const span = b.pos - a.pos;
      const f = span > 1e-6 ? (t - a.pos) / span : 0;
      return a.color.a + (b.color.a - a.color.a) * f;
    }
  }
  return stops[stops.length - 1]!.color.a;
}

/**
 * RGBA8 GL readback -> ImageData. The brush-flatten target is rendered with a
 * non-flipping fullscreen quad while sampling the (top-down) layer texture, so
 * framebuffer row 0 already holds the layer's top row. readPixels returns rows
 * starting at row 0, so the buffer is top-down — copy straight through.
 */
function rawToImageData(raw: Uint8Array, w: number, h: number): ImageData {
  const out = new Uint8ClampedArray(w * h * 4);
  out.set(raw.subarray(0, w * h * 4));
  return new ImageData(out, w, h);
}

/** Encode top-down RGBA bytes as a PNG Blob. */
async function encodePng(
  data: Uint8ClampedArray,
  w: number,
  h: number,
): Promise<Blob> {
  // Re-wrap in a fresh, ArrayBuffer-backed view so ImageData's typing accepts it.
  const pixels = new Uint8ClampedArray(w * h * 4);
  pixels.set(data);
  const imageData = new ImageData(pixels, w, h);
  const canvas =
    typeof OffscreenCanvas !== "undefined"
      ? new OffscreenCanvas(w, h)
      : Object.assign(document.createElement("canvas"), { width: w, height: h });
  const ctx = (canvas as HTMLCanvasElement | OffscreenCanvas).getContext("2d", {
    colorSpace: "srgb",
  }) as CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;
  ctx.putImageData(imageData, 0, 0);
  if (canvas instanceof OffscreenCanvas) {
    return canvas.convertToBlob({ type: "image/png" });
  }
  return new Promise<Blob>((resolve, reject) => {
    (canvas as HTMLCanvasElement).toBlob(
      (b) => (b ? resolve(b) : reject(new Error("toBlob failed"))),
      "image/png",
    );
  });
}
