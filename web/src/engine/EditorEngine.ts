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
} from "./gl/shaders";
import {
  Document,
  BLEND_MODE_INDEX,
  isAdjustmentLayer,
  type DocumentSnapshot,
  type LayerId,
  type LayerNode,
  type RasterLayer,
  type AdjustmentLayer,
  type AdjustmentType,
  type AdjustmentParams,
} from "../model/Document";
import * as m3 from "./math/mat3";
import { Selection } from "./Selection";
import { BrushEngine } from "./paint/BrushEngine";
import { History, paramCommand } from "./history/History";
import {
  toolStore,
  isPaintTool,
  isSelectionTool,
  selectionOpFromEvent,
  type ToolId,
  type RGBAColor,
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

  /** Ping-pong accumulators for backdrop-reading blend modes. */
  private accumA: FramebufferHandle | null = null;
  private accumB: FramebufferHandle | null = null;

  private selection: Selection | null = null;
  private brush: BrushEngine | null = null;

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
    | { kind: "marquee"; shape: "rect" | "ellipse"; startDoc: { x: number; y: number }; op: ReturnType<typeof selectionOpFromEvent> }
    | { kind: "lasso"; pts: number[]; op: ReturnType<typeof selectionOpFromEvent> }
    | { kind: "gradient"; layerId: LayerId; from: { x: number; y: number }; to: { x: number; y: number } } = {
    kind: "none",
  };
  /** Live gradient drag line (doc px) for a UI overlay, or null. */
  private liveGradient: { from: { x: number; y: number }; to: { x: number; y: number } } | null = null;
  private lastPointer = { x: 0, y: 0 };
  private spaceHeld = false;
  /** Live marquee preview rect in doc px (for overlay), or null. */
  private liveMarquee: { x0: number; y0: number; x1: number; y1: number } | null = null;

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
    // Adjustment layers cover the whole document.
    if (l.kind !== "raster") {
      return { x: 0, y: 0, width: this.doc.width, height: this.doc.height };
    }
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
    this.accumA = null;
    this.accumB = null;
    this.selection?.dispose();
    this.selection = null;
    this.brush?.dispose();
    this.brush = null;
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
    if (!r || !layer || layer.kind !== "raster") return null; // adjustments have no pixels
    let source: TexImageSource;
    if (typeof ImageData !== "undefined" && layer.source instanceof ImageData) {
      const cv = document.createElement("canvas");
      cv.width = layer.source.width;
      cv.height = layer.source.height;
      cv.getContext("2d")!.putImageData(layer.source, 0, 0);
      source = cv;
    } else {
      source = layer.source as ImageBitmap;
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
      const cl = this.doc.getLayer(clipTex.layerId)!;
      const m = this.viewportUvToLayerUv(bw, bh, cl as RasterLayer);
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

  /** The raster layer directly below `adjId` in stack order, as a texture. */
  private resolveClipTexture(
    adjId: LayerId,
  ): { tex: TextureHandle; layerId: LayerId } | null {
    const order = this.doc.orderBottomToTop();
    const idx = order.indexOf(adjId);
    for (let i = idx - 1; i >= 0; i--) {
      const below = this.doc.getLayer(order[i]!);
      if (below && below.kind === "raster") {
        const tex = this.resolveTexture(below.id);
        if (tex) return { tex, layerId: below.id };
        return null;
      }
      // Stop at the first non-adjustment layer below; if it's an adjustment,
      // keep walking down to find a raster to clip against.
      if (below && below.kind !== "adjustment") break;
    }
    return null;
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

  /** Viewport-uv -> a specific raster layer's local uv (for clipping). */
  private viewportUvToLayerUv(bw: number, bh: number, layer: RasterLayer): Float32Array {
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

    gl.useProgram(this.blendProgram);
    const P = this.blendProgram;
    const uTransform = gl.getUniformLocation(P, "u_transform");
    const uOpacity = gl.getUniformLocation(P, "u_opacity");
    const uTex = gl.getUniformLocation(P, "u_tex");
    const uBackdrop = gl.getUniformLocation(P, "u_backdrop");
    const uMask = gl.getUniformLocation(P, "u_mask");
    const uSel = gl.getUniformLocation(P, "u_selection");
    const uSrgb = gl.getUniformLocation(P, "u_srgbSource");
    const uUseMask = gl.getUniformLocation(P, "u_useMask");
    const uUseSel = gl.getUniformLocation(P, "u_useSelection");
    const uMode = gl.getUniformLocation(P, "u_blendMode");
    const uBackSize = gl.getUniformLocation(P, "u_backdropSize");
    const uUvToSel = gl.getUniformLocation(P, "u_uvToSel");
    gl.uniform1i(uTex, 0);
    gl.uniform1i(uBackdrop, 1);
    gl.uniform1i(uMask, 2);
    gl.uniform1i(uSel, 3);

    const pixToClip = m3.pixelToClip(bw, bh);
    const view = m3.multiply(
      m3.translation(this.view.tx, this.view.ty),
      m3.scaling(this.view.scale, this.view.scale),
    );
    const activeId = this.doc.getActiveLayerId();
    const order = this.doc.orderBottomToTop();

    for (const id of order) {
      const layer = this.doc.getLayer(id);
      if (!layer || !layer.visible || layer.opacity <= 0) continue;

      // Adjustment layers: fullscreen pass over the current accumulator.
      if (isAdjustmentLayer(layer)) {
        this.renderAdjustmentLayer(layer, read, write, bw, bh, view, pixToClip);
        const swp = read;
        read = write;
        write = swp;
        // Re-bind the blend program for the next raster layer iteration.
        gl.useProgram(P);
        gl.uniform1i(uTex, 0);
        gl.uniform1i(uBackdrop, 1);
        gl.uniform1i(uMask, 2);
        gl.uniform1i(uSel, 3);
        continue;
      }

      const tex = this.resolveLayerCompositeTexture(id);
      if (!tex) continue;

      const toDocPx = m3.multiply(
        m3.translation(layer.x, layer.y),
        m3.scaling(layer.width, layer.height),
      );
      const transform = m3.multiply(pixToClip, m3.multiply(view, toDocPx));

      // The blend shader reads the backdrop and writes the FULL composited
      // pixel (no fixed-function blending), but it only runs for fragments
      // inside the layer quad. So first COPY the backdrop into `write` (preserve
      // everything outside the quad), then draw the layer quad on top.
      gl.bindFramebuffer(gl.FRAMEBUFFER, write.fbo);
      gl.viewport(0, 0, bw, bh);
      gl.disable(gl.BLEND);
      this.blitBackdrop(read);

      // Restore blend program state for the quad pass.
      gl.useProgram(P);
      gl.uniform1i(uTex, 0);
      gl.uniform1i(uBackdrop, 1);
      gl.uniform1i(uMask, 2);
      gl.uniform1i(uSel, 3);
      gl.uniformMatrix3fv(uTransform, false, transform);
      gl.uniform1f(uOpacity, layer.opacity);
      gl.uniform1i(uSrgb, tex.srgb ? 0 : 1);
      gl.uniform1i(uMode, BLEND_MODE_INDEX[layer.blendMode]);
      gl.uniform2f(uBackSize, bw, bh);

      // Layer mask.
      const maskTex = layer.mask?.enabled ? this.resolveMaskTexture(layer) : null;
      gl.uniform1i(uUseMask, maskTex ? 1 : 0);
      if (maskTex) {
        gl.activeTexture(gl.TEXTURE2);
        gl.bindTexture(gl.TEXTURE_2D, maskTex.tex);
      }
      gl.uniform1i(uUseSel, 0); // selection does not gate compositing visibility

      // Bind backdrop (read accumulator) and source.
      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_2D, read.color.tex);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, tex.tex);
      r.drawQuad();

      // Live brush preview: composite the wet stroke over THIS layer in place
      // before it becomes the backdrop, so the preview blends correctly.
      if (
        this.brush &&
        this.brush.isActive &&
        this.gesture.kind === "paint" &&
        this.gesture.layerId === id &&
        !this.gesture.onMask
      ) {
        // Overlays the wet stroke onto the just-written layer pixel. The next
        // loop iteration re-selects the blend program via blitBackdrop().
        this.compositeBrushPreview(write, layer);
      }
      void uUvToSel;
      void uUseSel;

      const t = read;
      read = write;
      write = t;
    }

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

  /**
   * Composite the live wet stroke over `write` (the just-written layer pixel),
   * mapping the layer-local wet buffer into the viewport via the view xform.
   * Paint = premultiplied source-over of the brush color; erase = reduce alpha.
   * This is a fast preview only; the authoritative pixels are produced on commit.
   */
  private compositeBrushPreview(write: FramebufferHandle, layer: RasterLayer): void {
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

    if (tool === "move" && activeId) {
      const layer = this.doc.getLayer(activeId);
      if (layer && layer.kind === "raster") {
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

    if (isPaintTool(tool) && activeId) {
      this.beginPaint(activeId, doc, e);
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
      const nx = Math.round(g.origX + (doc.x - g.startX));
      const ny = Math.round(g.origY + (doc.y - g.startY));
      this.doc.setPosition(g.layerId, nx, ny);
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
        // Adjustment-mask painting is full-doc (origin 0,0); raster uses x/y.
        const lx0 = layer.kind === "raster" ? layer.x : 0;
        const ly0 = layer.kind === "raster" ? layer.y : 0;
        const lx = doc.x - lx0;
        const ly = doc.y - ly0;
        this.brush?.stampTo(lx, ly, ce.pressure);
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
      const doc = this.screenToDoc(local.x, local.y);
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
      if (layer && layer.kind === "raster" && (layer.x !== g.origX || layer.y !== g.origY)) {
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

    if (g.kind === "gradient") {
      this.liveGradient = null;
      const ts = toolStore.get();
      // Zero-length drag = no gradient.
      if (Math.hypot(g.to.x - g.from.x, g.to.y - g.from.y) >= 1) {
        this.applyGradientFill(g.layerId, {
          type: "linear",
          from: g.from,
          to: g.to,
          stops: [
            { pos: 0, color: { ...ts.foreground } },
            { pos: 1, color: { ...ts.background } },
          ],
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
  }

  private handleKeyDown(e: KeyboardEvent): void {
    const meta = e.metaKey || e.ctrlKey;
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
      if (layer.kind !== "raster") continue; // adjustments don't add pixels here
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
    const layer = this.doc.getLayer(id);
    if (!layer || layer.kind !== "adjustment") return;
    const prev = !!layer.clipping;
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

    const P = this.blendProgram;
    const pixToClip = m3.pixelToClip(w, h);
    const view = m3.identity();
    // Stash + override the live view so adjustment uv->doc math uses identity.
    const savedView = this.view;
    this.view = { scale: 1, tx: 0, ty: 0 };

    for (const id of this.doc.orderBottomToTop()) {
      const layer = this.doc.getLayer(id);
      if (!layer || !layer.visible || layer.opacity <= 0) continue;
      if (isAdjustmentLayer(layer)) {
        this.renderAdjustmentLayer(layer, read, write, w, h, view, pixToClip);
        const swp = read; read = write; write = swp;
        continue;
      }
      const tex = this.resolveTexture(id);
      if (!tex) continue;
      gl.bindFramebuffer(gl.FRAMEBUFFER, write.fbo);
      gl.viewport(0, 0, w, h);
      gl.disable(gl.BLEND);
      this.blitBackdrop(read);

      gl.useProgram(P);
      const toDocPx = m3.multiply(m3.translation(layer.x, layer.y), m3.scaling(layer.width, layer.height));
      const transform = m3.multiply(pixToClip, toDocPx);
      gl.uniform1i(gl.getUniformLocation(P, "u_tex"), 0);
      gl.uniform1i(gl.getUniformLocation(P, "u_backdrop"), 1);
      gl.uniform1i(gl.getUniformLocation(P, "u_mask"), 2);
      gl.uniform1i(gl.getUniformLocation(P, "u_selection"), 3);
      gl.uniformMatrix3fv(gl.getUniformLocation(P, "u_transform"), false, transform);
      gl.uniform1f(gl.getUniformLocation(P, "u_opacity"), layer.opacity);
      gl.uniform1i(gl.getUniformLocation(P, "u_srgbSource"), tex.srgb ? 0 : 1);
      gl.uniform1i(gl.getUniformLocation(P, "u_blendMode"), BLEND_MODE_INDEX[layer.blendMode]);
      gl.uniform2f(gl.getUniformLocation(P, "u_backdropSize"), w, h);
      const maskTex = layer.mask?.enabled ? this.resolveMaskTexture(layer) : null;
      gl.uniform1i(gl.getUniformLocation(P, "u_useMask"), maskTex ? 1 : 0);
      if (maskTex) {
        gl.activeTexture(gl.TEXTURE2);
        gl.bindTexture(gl.TEXTURE_2D, maskTex.tex);
      }
      gl.uniform1i(gl.getUniformLocation(P, "u_useSelection"), 0);
      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_2D, read.color.tex);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, tex.tex);
      r.drawQuad();
      const swp = read; read = write; write = swp;
    }
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
}

// ── module-level helpers ──────────────────────────────────
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
