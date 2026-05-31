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
  type DocumentSnapshot,
  type LayerId,
  type RasterLayer,
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
} from "../state/tools";

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
    | { kind: "lasso"; pts: number[]; op: ReturnType<typeof selectionOpFromEvent> } = {
    kind: "none",
  };
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
    return l ? { x: l.x, y: l.y, width: l.width, height: l.height } : null;
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
    if (!layer || !tex) throw new Error("Layer not found.");
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
      // Sample the selection over the layer's footprint into a layer-sized R8.
      data = this.sampleSelectionIntoLayer(layer);
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
    if (!r || !layer) return null;
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
  private resolveMaskTexture(layer: RasterLayer): TextureHandle | null {
    const r = this.renderer;
    if (!r || !layer.mask) return null;
    const cached = this.maskTextures.get(layer.id);
    if (cached && cached.version === layer.mask.version) return cached.tex;
    if (cached) r.deleteTexture(cached.tex);
    const tex = r.createR8Texture(layer.mask.data, layer.mask.width, layer.mask.height);
    this.maskTextures.set(layer.id, { tex, version: layer.mask.version });
    return tex;
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
      const tex = this.resolveTexture(id);
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
    // Phase 2 paints white (mask/foreground); a color picker lands later.
    return [1, 1, 1];
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
      if (layer) {
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
        const lx = doc.x - layer.x;
        const ly = doc.y - layer.y;
        this.brush?.stampTo(lx, ly, ce.pressure);
      }
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
      if (layer && (layer.x !== g.origX || layer.y !== g.origY)) {
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
    const target = {
      width: onMask ? layer.mask!.width : layer.width,
      height: onMask ? layer.mask!.height : layer.height,
      x: layer.x,
      y: layer.y,
    };
    const selTex = sel && !sel.isEmpty() ? sel.texture : null;
    brush.begin(target, toolStore.get().brush, selTex, sel ? sel.size : { width: this.doc.width, height: this.doc.height });
    this.gesture = { kind: "paint", layerId, onMask };
    const lx = doc.x - layer.x;
    const ly = doc.y - layer.y;
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
    } else {
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
    layer: RasterLayer,
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
