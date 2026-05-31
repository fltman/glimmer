/**
 * Selection — a single-channel (R8) full-document mask, value 0..1.
 *
 * The mask lives entirely on the GPU (a ping-pong pair of R8 framebuffers in
 * document resolution). Marquee primitives are rasterized by a shader; lasso
 * polygons are rasterized on a 2D canvas (even-odd fill) and uploaded, then
 * combined into the live mask with a boolean op and optionally feathered with a
 * separable Gaussian. The engine samples this texture during compositing
 * (region edits / mask painting) and visualises the contour with marching ants.
 *
 * CPU-authoritative recovery: the mask is regenerated lazily, so on GL context
 * loss the engine simply clears it (an empty selection means "whole document",
 * which is the safe default for the AI region-export APIs).
 */
import type {
  WebGL2Renderer,
  FramebufferHandle,
} from "./gl/Renderer";
import {
  QUAD_VERT,
  SEL_SHAPE_FRAG,
  SEL_COMBINE_FRAG,
  BLUR_FRAG,
  R_COPY_FRAG,
} from "./gl/shaders";
import type { SelectionOp } from "../state/tools";

const OP_INDEX: Record<SelectionOp, number> = {
  replace: 0,
  add: 1,
  subtract: 2,
  intersect: 3,
};

export interface SelectionBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

export class Selection {
  private r: WebGL2Renderer;
  private docW = 0;
  private docH = 0;

  /** Ping-pong R8 targets; `front` holds the committed selection. */
  private front: FramebufferHandle | null = null;
  private back: FramebufferHandle | null = null;
  private scratch: FramebufferHandle | null = null;

  private shapeProg: WebGLProgram;
  private combineProg: WebGLProgram;
  private blurProg: WebGLProgram;
  private copyProg: WebGLProgram;

  private empty = true;
  /** Cached CPU bounds in doc px (null when empty / unknown). */
  private bounds: SelectionBounds | null = null;

  constructor(renderer: WebGL2Renderer) {
    this.r = renderer;
    this.shapeProg = renderer.compileProgram(QUAD_VERT, SEL_SHAPE_FRAG);
    this.combineProg = renderer.compileProgram(QUAD_VERT, SEL_COMBINE_FRAG);
    this.blurProg = renderer.compileProgram(QUAD_VERT, BLUR_FRAG);
    this.copyProg = renderer.compileProgram(QUAD_VERT, R_COPY_FRAG);
  }

  // ── lifecycle ───────────────────────────────────────────
  /** (Re)allocate targets to the current document size; clears the selection. */
  resize(width: number, height: number): void {
    if (this.docW === width && this.docH === height && this.front) return;
    this.dispose();
    this.docW = Math.max(1, Math.round(width));
    this.docH = Math.max(1, Math.round(height));
    this.front = this.r.createR8Target(this.docW, this.docH);
    this.back = this.r.createR8Target(this.docW, this.docH);
    this.scratch = this.r.createR8Target(this.docW, this.docH);
    this.clear();
  }

  dispose(): void {
    if (this.front) this.r.deleteFramebuffer(this.front);
    if (this.back) this.r.deleteFramebuffer(this.back);
    if (this.scratch) this.r.deleteFramebuffer(this.scratch);
    this.front = this.back = this.scratch = null;
  }

  // ── reads ───────────────────────────────────────────────
  isEmpty(): boolean {
    return this.empty;
  }
  get texture(): WebGLTexture | null {
    return this.front?.color.tex ?? null;
  }
  get framebuffer(): FramebufferHandle | null {
    return this.front;
  }
  get size(): { width: number; height: number } {
    return { width: this.docW, height: this.docH };
  }

  /** Tight integer bounds of the >0 region, or null when empty. */
  getBounds(): SelectionBounds | null {
    if (this.empty) return null;
    if (this.bounds) return this.bounds;
    this.bounds = this.computeBounds();
    return this.bounds;
  }

  // ── editing ─────────────────────────────────────────────
  clear(): void {
    if (!this.front) return;
    const gl = this.r.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.front.fbo);
    gl.viewport(0, 0, this.docW, this.docH);
    gl.disable(gl.BLEND);
    gl.clearColor(0, 0, 0, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    this.empty = true;
    this.bounds = null;
  }

  selectAll(): void {
    if (!this.front) return;
    const gl = this.r.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.front.fbo);
    gl.viewport(0, 0, this.docW, this.docH);
    gl.disable(gl.BLEND);
    gl.clearColor(1, 0, 0, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    this.empty = false;
    this.bounds = { x: 0, y: 0, width: this.docW, height: this.docH };
  }

  /**
   * Commit a rectangle or ellipse marquee (doc px) with a boolean op + feather.
   */
  commitShape(
    kind: "rect" | "ellipse",
    rect: { x0: number; y0: number; x1: number; y1: number },
    op: SelectionOp,
    feather: number,
  ): void {
    if (!this.front || !this.scratch) return;
    const gl = this.r.gl;
    // 1. Rasterize the shape into scratch (normalized coords).
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.scratch.fbo);
    gl.viewport(0, 0, this.docW, this.docH);
    gl.disable(gl.BLEND);
    gl.clearColor(0, 0, 0, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.useProgram(this.shapeProg);
    this.setFullscreen(this.shapeProg);
    gl.uniform1i(gl.getUniformLocation(this.shapeProg, "u_shape"), kind === "ellipse" ? 1 : 0);
    gl.uniform4f(
      gl.getUniformLocation(this.shapeProg, "u_rect"),
      rect.x0 / this.docW,
      rect.y0 / this.docH,
      rect.x1 / this.docW,
      rect.y1 / this.docH,
    );
    gl.uniform2f(gl.getUniformLocation(this.shapeProg, "u_docSize"), this.docW, this.docH);
    this.r.drawQuad();
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);

    this.combineFromScratch(op);
    if (feather > 0) this.applyFeather(feather);
    this.afterEdit();
  }

  /**
   * Commit a lasso polygon. `pts` are doc-space px pairs [x0,y0,x1,y1,...].
   * Rasterized on a 2D canvas (even-odd fill), uploaded to scratch, combined.
   */
  commitPolygon(
    pts: number[],
    op: SelectionOp,
    feather: number,
  ): void {
    if (!this.front || !this.scratch || pts.length < 6) return;
    const cv = document.createElement("canvas");
    cv.width = this.docW;
    cv.height = this.docH;
    const ctx = cv.getContext("2d", { willReadFrequently: true });
    if (!ctx) return;
    ctx.fillStyle = "#000";
    ctx.fillRect(0, 0, this.docW, this.docH);
    ctx.fillStyle = "#fff";
    ctx.beginPath();
    ctx.moveTo(pts[0]!, pts[1]!);
    for (let i = 2; i < pts.length; i += 2) ctx.lineTo(pts[i]!, pts[i + 1]!);
    ctx.closePath();
    ctx.fill("evenodd");
    const img = ctx.getImageData(0, 0, this.docW, this.docH);
    // Pack the red channel into an R8 buffer.
    const r8 = new Uint8Array(this.docW * this.docH);
    for (let i = 0; i < r8.length; i++) r8[i] = img.data[i * 4]!;
    const tex = this.r.createR8Texture(r8, this.docW, this.docH);

    const gl = this.r.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.scratch.fbo);
    gl.viewport(0, 0, this.docW, this.docH);
    gl.disable(gl.BLEND);
    gl.useProgram(this.copyProg);
    this.setFullscreen(this.copyProg);
    gl.uniform1i(gl.getUniformLocation(this.copyProg, "u_src"), 0);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, tex.tex);
    // The lasso texture's row 0 is the canvas top (= doc-top), matching the
    // selection's stored orientation (framebuffer/texture row 0 = doc-top), so
    // the copy is a straight pass-through.
    this.r.drawQuad();
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    this.r.deleteTexture(tex);

    this.combineFromScratch(op);
    if (feather > 0) this.applyFeather(feather);
    this.afterEdit();
  }

  /** Replace the entire selection with a raw R8 buffer (doc-sized). */
  setFromBuffer(buf: Uint8Array): void {
    if (!this.front || buf.length < this.docW * this.docH) return;
    const tex = this.r.createR8Texture(buf, this.docW, this.docH);
    const gl = this.r.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.front.fbo);
    gl.viewport(0, 0, this.docW, this.docH);
    gl.disable(gl.BLEND);
    gl.useProgram(this.copyProg);
    this.setFullscreen(this.copyProg);
    gl.uniform1i(gl.getUniformLocation(this.copyProg, "u_src"), 0);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, tex.tex);
    this.r.drawQuad();
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    this.r.deleteTexture(tex);
    this.afterEdit();
  }

  // ── internals ───────────────────────────────────────────
  /** Fullscreen quad transform (quad [0,1] -> clip), no Y flip. */
  private setFullscreen(prog: WebGLProgram): void {
    const gl = this.r.gl;
    gl.uniformMatrix3fv(
      gl.getUniformLocation(prog, "u_transform"),
      false,
      new Float32Array([2, 0, 0, 0, 2, 0, -1, -1, 1]),
    );
  }

  /** Combine `scratch` into `front` via the boolean op (writes to back, swaps). */
  private combineFromScratch(op: SelectionOp): void {
    if (!this.front || !this.back || !this.scratch) return;
    const gl = this.r.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.back.fbo);
    gl.viewport(0, 0, this.docW, this.docH);
    gl.disable(gl.BLEND);
    gl.useProgram(this.combineProg);
    this.setFullscreen(this.combineProg);
    gl.uniform1i(gl.getUniformLocation(this.combineProg, "u_existing"), 0);
    gl.uniform1i(gl.getUniformLocation(this.combineProg, "u_stamp"), 1);
    gl.uniform1i(gl.getUniformLocation(this.combineProg, "u_op"), OP_INDEX[op]);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.front.color.tex);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.scratch.color.tex);
    this.r.drawQuad();
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    this.swapFrontBack();
  }

  /** Two-pass separable Gaussian feather on the front buffer. */
  private applyFeather(radiusPx: number): void {
    if (!this.front || !this.back) return;
    const gl = this.r.gl;
    const sigma = Math.max(0.5, radiusPx / 2);
    const radius = Math.min(32, Math.ceil(radiusPx));
    const pass = (
      srcTex: WebGLTexture,
      dst: FramebufferHandle,
      dir: [number, number],
    ) => {
      gl.bindFramebuffer(gl.FRAMEBUFFER, dst.fbo);
      gl.viewport(0, 0, this.docW, this.docH);
      gl.disable(gl.BLEND);
      gl.useProgram(this.blurProg);
      this.setFullscreen(this.blurProg);
      gl.uniform1i(gl.getUniformLocation(this.blurProg, "u_src"), 0);
      gl.uniform2f(gl.getUniformLocation(this.blurProg, "u_dir"), dir[0], dir[1]);
      gl.uniform1i(gl.getUniformLocation(this.blurProg, "u_radius"), radius);
      gl.uniform1f(gl.getUniformLocation(this.blurProg, "u_sigma"), sigma);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, srcTex);
      this.r.drawQuad();
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    };
    // front -> back (horizontal), back -> front (vertical).
    pass(this.front.color.tex, this.back, [1 / this.docW, 0]);
    pass(this.back.color.tex, this.front, [0, 1 / this.docH]);
  }

  private swapFrontBack(): void {
    const t = this.front;
    this.front = this.back;
    this.back = t;
  }

  private afterEdit(): void {
    this.bounds = this.computeBounds();
    this.empty = this.bounds === null;
  }

  /** Read back the mask and compute a tight bounding box of value > ~2/255. */
  private computeBounds(): SelectionBounds | null {
    if (!this.front) return null;
    // Selection targets store doc-top at texture/framebuffer row 0, and
    // readR8 returns rows starting at the bottom-most framebuffer row of the
    // region (= row 0 = doc-top). So the buffer is already top-down in doc
    // space — no Y flip needed.
    const px = this.r.readR8(this.front, 0, 0, this.docW, this.docH);
    let minX = this.docW,
      minY = this.docH,
      maxX = -1,
      maxY = -1;
    for (let y = 0; y < this.docH; y++) {
      const row = y * this.docW;
      for (let x = 0; x < this.docW; x++) {
        if (px[row + x]! > 2) {
          if (x < minX) minX = x;
          if (x > maxX) maxX = x;
          if (y < minY) minY = y;
          if (y > maxY) maxY = y;
        }
      }
    }
    if (maxX < 0) return null;
    return {
      x: minX,
      y: minY,
      width: maxX - minX + 1,
      height: maxY - minY + 1,
    };
  }
}
