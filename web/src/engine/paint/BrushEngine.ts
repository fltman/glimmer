/**
 * BrushEngine — GPU dab stamping into a per-stroke "wet" buffer.
 *
 * One stroke = a sequence of soft-round dabs stamped (with MAX blending so
 * overlapping dabs in a single stroke don't darken) into a layer-sized R8 wet
 * buffer. The buffer is composited live by the engine for preview, and on
 * pointer-up the engine flattens it into the active layer's RGBA8 texture (paint
 * or erase) or a layer mask — producing exactly one undo step.
 *
 * The brush spaces dabs along the path at ~10% of the diameter, interpolating
 * between coalesced pointer samples for smooth strokes. Pressure scales radius
 * and flow. Painting is constrained to the active selection inside the dab
 * shader.
 */
import type { WebGL2Renderer, FramebufferHandle } from "../gl/Renderer";
import { QUAD_VERT, DAB_FRAG } from "../gl/shaders";
import * as m3 from "../math/mat3";
import type { BrushParams } from "../../state/tools";

interface StrokeTarget {
  /** Layer-local width/height the wet buffer must cover. */
  width: number;
  height: number;
  /** Top-left of the layer in document space (for selection sampling). */
  x: number;
  y: number;
}

export class BrushEngine {
  private r: WebGL2Renderer;
  private dabProg: WebGLProgram;

  private wet: FramebufferHandle | null = null;
  private active = false;
  private params: BrushParams = { size: 48, opacity: 1, hardness: 0.8, flow: 1 };
  private target: StrokeTarget | null = null;
  private last: { x: number; y: number; pressure: number } | null = null;
  /** Distance accumulator so dabs are evenly spaced along the path. */
  private carry = 0;
  /** Selection sampling state for the active stroke. */
  private selTex: WebGLTexture | null = null;
  private docSize = { width: 1, height: 1 };

  constructor(renderer: WebGL2Renderer) {
    this.r = renderer;
    this.dabProg = renderer.compileProgram(QUAD_VERT, DAB_FRAG);
  }

  get isActive(): boolean {
    return this.active;
  }
  /** The live wet buffer (single-channel coverage), or null when idle. */
  get wetBuffer(): FramebufferHandle | null {
    return this.wet;
  }

  /**
   * Begin a stroke covering `target` (layer-local space). `selTex` (optional)
   * constrains painting to the document selection; `docSize` is the selection
   * texture size in px.
   */
  begin(
    target: StrokeTarget,
    params: BrushParams,
    selTex: WebGLTexture | null,
    docSize: { width: number; height: number },
  ): void {
    this.ensureWet(target.width, target.height);
    this.clearWet();
    this.active = true;
    this.params = params;
    this.target = target;
    this.selTex = selTex;
    this.docSize = docSize;
    this.last = null;
    this.carry = 0;
  }

  /** Stamp dabs from the previous sample to (x,y) in layer-local px. */
  stampTo(x: number, y: number, pressure: number): void {
    if (!this.active || !this.wet) return;
    const p = pressure > 0 ? pressure : 1;
    if (!this.last) {
      this.stampDab(x, y, p);
      this.last = { x, y, pressure: p };
      return;
    }
    const ax = this.last.x;
    const ay = this.last.y;
    const dx = x - ax;
    const dy = y - ay;
    const dist = Math.hypot(dx, dy);
    const spacing = Math.max(1, this.params.size * 0.1);
    let traveled = this.carry;
    const startPressure = this.last.pressure;
    while (traveled + spacing <= dist) {
      traveled += spacing;
      const t = dist > 0 ? traveled / dist : 0;
      const px = ax + dx * t;
      const py = ay + dy * t;
      const pr = startPressure + (p - startPressure) * t;
      this.stampDab(px, py, pr);
    }
    this.carry = traveled - dist; // remainder carried into the next segment
    this.last = { x, y, pressure: p };
  }

  /** End the stroke; the engine flattens the wet buffer, then calls reset(). */
  end(): void {
    this.active = false;
    this.last = null;
    this.target = null;
    this.selTex = null;
  }

  dispose(): void {
    if (this.wet) this.r.deleteFramebuffer(this.wet);
    this.wet = null;
  }

  // ── internals ───────────────────────────────────────────
  private ensureWet(w: number, h: number): void {
    if (this.wet && this.wet.width === w && this.wet.height === h) return;
    if (this.wet) this.r.deleteFramebuffer(this.wet);
    this.wet = this.r.createR8Target(Math.max(1, w), Math.max(1, h));
  }

  private clearWet(): void {
    if (!this.wet) return;
    const gl = this.r.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.wet.fbo);
    gl.viewport(0, 0, this.wet.width, this.wet.height);
    gl.disable(gl.BLEND);
    gl.clearColor(0, 0, 0, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  }

  private stampDab(cx: number, cy: number, pressure: number): void {
    const wet = this.wet;
    const target = this.target;
    if (!wet || !target) return;
    const gl = this.r.gl;
    const diameter = this.params.size * pressure;
    const radius = diameter / 2;
    const x0 = cx - radius;
    const y0 = cy - radius;

    gl.bindFramebuffer(gl.FRAMEBUFFER, wet.fbo);
    gl.viewport(0, 0, wet.width, wet.height);
    // MAX blending: keep the strongest coverage so a stroke doesn't build up.
    gl.enable(gl.BLEND);
    gl.blendEquation(gl.MAX);
    gl.blendFunc(gl.ONE, gl.ONE);

    gl.useProgram(this.dabProg);
    // quad [0,1] -> layer px (top-left origin, +y DOWN to match the buffer).
    const pixToClip = new Float32Array([
      2 / wet.width, 0, 0,
      0, 2 / wet.height, 0,
      -1, -1, 1,
    ]);
    const toPx = m3.multiply(
      m3.translation(x0, y0),
      m3.scaling(diameter, diameter),
    );
    const transform = m3.multiply(pixToClip, toPx);
    gl.uniformMatrix3fv(
      gl.getUniformLocation(this.dabProg, "u_transform"),
      false,
      transform,
    );
    gl.uniform1f(gl.getUniformLocation(this.dabProg, "u_hardness"), this.params.hardness);
    gl.uniform1f(gl.getUniformLocation(this.dabProg, "u_flow"), this.params.flow);

    const useSel = !!this.selTex;
    gl.uniform1i(gl.getUniformLocation(this.dabProg, "u_useSelection"), useSel ? 1 : 0);
    if (useSel) {
      // dab uv [0,1] -> layer px -> doc px -> selection uv [0,1].
      // dab px = x0 + u*diameter ; doc px = layerX + dabpx ; sel uv = docpx/docSize
      const sx = diameter / this.docSize.width;
      const sy = diameter / this.docSize.height;
      const tx = (target.x + x0) / this.docSize.width;
      const ty = (target.y + y0) / this.docSize.height;
      const uvToSel = new Float32Array([sx, 0, 0, 0, sy, 0, tx, ty, 1]);
      gl.uniformMatrix3fv(
        gl.getUniformLocation(this.dabProg, "u_uvToSel"),
        false,
        uvToSel,
      );
      gl.uniform1i(gl.getUniformLocation(this.dabProg, "u_selection"), 0);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, this.selTex);
    }
    this.r.drawQuad();

    // Restore default blend state for downstream passes.
    gl.blendEquation(gl.FUNC_ADD);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  }
}
