/**
 * RetouchEngine — stroke-based brushes that read and rewrite the EXISTING layer
 * pixels: clone stamp, healing brush, dodge, burn, smudge, blur, sharpen.
 *
 * Unlike the plain BrushEngine (which accumulates coverage into a wet buffer and
 * flattens once on pointer-up), retouch brushes must see their own in-progress
 * result so that neighbouring samples are correct (an aligned clone source, a
 * smudge pickup point, a blurred neighbourhood). So this engine keeps a
 * ping-pong pair of RGBA8 "working" buffers sized to the layer, seeds them from
 * the layer's current texture at stroke start, and applies each dab as a small
 * full-layer pass (read working buffer -> write the other) using a per-dab wet
 * coverage mask and the mode's retouch-apply shader. The engine reads the final
 * working buffer back on pointer-up as ONE undo step.
 *
 * All passes operate on STRAIGHT-alpha display-sRGB RGBA8 (the layer source
 * format). Pass 0 reads the SRGB-decoding layer texture (so the shader decodes
 * then re-encodes); every later pass reads an RGBA8 working buffer verbatim
 * (display sRGB), matching the existing filter pipeline's convention.
 */
import type { WebGL2Renderer, FramebufferHandle, TextureHandle } from "../gl/Renderer";
import {
  QUAD_VERT,
  DAB_FRAG,
  RETOUCH_CLONE_FRAG,
  RETOUCH_HEAL_FRAG,
  RETOUCH_DODGEBURN_FRAG,
  RETOUCH_SMUDGE_FRAG,
  RETOUCH_FOCUS_FRAG,
} from "../gl/shaders";
import * as m3 from "../math/mat3";

/** The retouch brush variants. */
export type RetouchMode =
  | "clone"
  | "heal"
  | "dodge"
  | "burn"
  | "smudge"
  | "blur"
  | "sharpen";

/** Shared brush geometry + per-mode strength params for a retouch stroke. */
export interface RetouchParams {
  /** Diameter in layer px. */
  size: number;
  /** Edge softness 0..1 (1 = hard). */
  hardness: number;
  /** Per-dab strength/opacity 0..1 (opacity for clone/heal, exposure for
   *  dodge/burn, strength for smudge/blur/sharpen). */
  amount: number;
  /** Dodge/burn tonal range. */
  range?: "shadows" | "midtones" | "highlights";
}

interface RetouchTarget {
  /** Layer-local size of the working buffers. */
  width: number;
  height: number;
  /** Top-left of the layer in document space (for selection sampling). */
  x: number;
  y: number;
}

export class RetouchEngine {
  private r: WebGL2Renderer;
  private dabProg: WebGLProgram;
  private cloneProg: WebGLProgram;
  private healProg: WebGLProgram;
  private dodgeBurnProg: WebGLProgram;
  private smudgeProg: WebGLProgram;
  private focusProg: WebGLProgram;

  /** Ping-pong working layer copies (RGBA8, display sRGB). `work` is current. */
  private work: FramebufferHandle | null = null;
  private workAlt: FramebufferHandle | null = null;
  /** Single-dab coverage mask (R8). */
  private dab: FramebufferHandle | null = null;

  private active = false;
  private mode: RetouchMode = "clone";
  private params: RetouchParams = { size: 48, hardness: 0.6, amount: 1 };
  private target: RetouchTarget | null = null;
  /** True until the working buffers have been seeded from the layer texture. */
  private seeded = false;

  private last: { x: number; y: number; pressure: number } | null = null;
  private carry = 0;
  /** Number of dabs that actually modified the working buffer this stroke. */
  private edits = 0;

  // Selection constraint.
  private selTex: WebGLTexture | null = null;
  private docSize = { width: 1, height: 1 };

  // ── clone-source state ──
  /** Aligned-clone offset (layer px) added to each dab to find the source. Set
   *  once the first dab of the first stroke after the source point is placed. */
  private cloneOffset: { dx: number; dy: number } | null = null;
  /** The clone SOURCE point in layer px (set by the engine via Alt-click). */
  private cloneSource: { x: number; y: number } | null = null;
  /** Whether the offset must be (re)anchored at the next stroke start. */
  private needAnchor = true;
  private aligned = true;

  // ── smudge state ──
  /** Previous dab center (layer px) for the smear direction. */
  private prevDab: { x: number; y: number } | null = null;

  constructor(renderer: WebGL2Renderer) {
    this.r = renderer;
    this.dabProg = renderer.compileProgram(QUAD_VERT, DAB_FRAG);
    this.cloneProg = renderer.compileProgram(QUAD_VERT, RETOUCH_CLONE_FRAG);
    this.healProg = renderer.compileProgram(QUAD_VERT, RETOUCH_HEAL_FRAG);
    this.dodgeBurnProg = renderer.compileProgram(QUAD_VERT, RETOUCH_DODGEBURN_FRAG);
    this.smudgeProg = renderer.compileProgram(QUAD_VERT, RETOUCH_SMUDGE_FRAG);
    this.focusProg = renderer.compileProgram(QUAD_VERT, RETOUCH_FOCUS_FRAG);
  }

  get isActive(): boolean {
    return this.active;
  }
  /** The current working layer copy (for live preview), or null. */
  get workTexture(): TextureHandle | null {
    return this.work?.color ?? null;
  }
  get activeMode(): RetouchMode {
    return this.mode;
  }

  // ── clone source ────────────────────────────────────────
  /** Set the clone source in layer-local px (Alt/Option-click). */
  setCloneSource(layerX: number, layerY: number): void {
    this.cloneSource = { x: layerX, y: layerY };
    this.needAnchor = true; // re-anchor the offset on the next stroke
  }
  getCloneSource(): { x: number; y: number } | null {
    return this.cloneSource ? { ...this.cloneSource } : null;
  }
  clearCloneSource(): void {
    this.cloneSource = null;
    this.cloneOffset = null;
    this.needAnchor = true;
  }

  /**
   * Begin a retouch stroke. `layerTex` is the layer's current GPU texture (used
   * to seed the working buffer on the first dab). `aligned` keeps the clone
   * source offset locked across strokes.
   */
  begin(
    mode: RetouchMode,
    target: RetouchTarget,
    params: RetouchParams,
    aligned: boolean,
    selTex: WebGLTexture | null,
    docSize: { width: number; height: number },
  ): void {
    this.ensureBuffers(target.width, target.height);
    this.mode = mode;
    this.params = params;
    this.target = target;
    this.aligned = aligned;
    this.selTex = selTex;
    this.docSize = docSize;
    this.active = true;
    this.seeded = false;
    this.last = null;
    this.carry = 0;
    this.edits = 0;
    this.prevDab = null;
    // Clone + heal both follow a source offset. Non-aligned re-anchors every
    // stroke; aligned keeps a fixed offset once anchored.
    if ((mode === "clone" || mode === "heal") && (!aligned || this.cloneOffset === null)) {
      this.needAnchor = true;
    }
  }

  /**
   * Seed the working buffers from the layer texture. Must be called by the
   * engine right after begin() while it still has the resolved texture handle
   * (RetouchEngine doesn't resolve textures itself).
   */
  seed(layerTex: TextureHandle): void {
    if (!this.work || !this.workAlt) return;
    this.blitTextureToWork(layerTex.tex, layerTex.srgb, this.work);
    // Mirror into the alt buffer so the first ping-pong read is valid too.
    this.blitTextureToWork(this.work.color.tex, false, this.workAlt);
    this.seeded = true;
  }

  /** Stamp dabs from the previous sample to (x,y) in layer-local px. */
  stampTo(x: number, y: number, pressure: number): void {
    if (!this.active || !this.work) return;
    const p = pressure > 0 ? pressure : 1;
    if (!this.last) {
      this.applyDab(x, y, p);
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
      this.applyDab(px, py, pr);
    }
    this.carry = traveled - dist;
    this.last = { x, y, pressure: p };
  }

  /** End the stroke; the engine reads back `workTexture` before calling this. */
  end(): void {
    this.active = false;
    this.last = null;
    this.target = null;
    this.selTex = null;
    this.prevDab = null;
  }

  dispose(): void {
    if (this.work) this.r.deleteFramebuffer(this.work);
    if (this.workAlt) this.r.deleteFramebuffer(this.workAlt);
    if (this.dab) this.r.deleteFramebuffer(this.dab);
    this.work = this.workAlt = this.dab = null;
  }

  // ── internals ───────────────────────────────────────────
  private ensureBuffers(w: number, h: number): void {
    const W = Math.max(1, w);
    const H = Math.max(1, h);
    if (this.work && this.work.width === W && this.work.height === H) return;
    if (this.work) this.r.deleteFramebuffer(this.work);
    if (this.workAlt) this.r.deleteFramebuffer(this.workAlt);
    if (this.dab) this.r.deleteFramebuffer(this.dab);
    this.work = this.r.createRGBA8Target(W, H);
    this.workAlt = this.r.createRGBA8Target(W, H);
    this.dab = this.r.createR8Target(W, H);
  }

  /** Copy a source texture into a working RGBA8 buffer (re-encode sRGB if needed). */
  private blitTextureToWork(
    tex: WebGLTexture,
    srgbDecoding: boolean,
    dst: FramebufferHandle,
  ): void {
    const gl = this.r.gl;
    const prog = this.seedProgram();
    gl.bindFramebuffer(gl.FRAMEBUFFER, dst.fbo);
    gl.viewport(0, 0, dst.width, dst.height);
    gl.disable(gl.BLEND);
    gl.useProgram(prog);
    gl.uniformMatrix3fv(
      gl.getUniformLocation(prog, "u_transform"),
      false,
      new Float32Array([2, 0, 0, 0, 2, 0, -1, -1, 1]),
    );
    gl.uniform1i(gl.getUniformLocation(prog, "u_src"), 0);
    gl.uniform1i(gl.getUniformLocation(prog, "u_decode"), srgbDecoding ? 1 : 0);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, tex);
    this.r.drawQuad();
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  }

  // Re-encode an sRGB-decoding texture back to display-sRGB bytes (or copy
  // verbatim when already RGBA8). Lazily compiled.
  private _seedProg: WebGLProgram | null = null;
  private seedProgram(): WebGLProgram {
    if (this._seedProg) return this._seedProg;
    const frag = /* glsl */ `#version 300 es
precision highp float;
in vec2 v_uv; out vec4 fragColor;
uniform sampler2D u_src; uniform bool u_decode;
vec3 linearToSrgb(vec3 c){return mix(c*12.92, 1.055*pow(c, vec3(1.0/2.4))-0.055, step(0.0031308,c));}
void main(){
  vec4 c = texture(u_src, v_uv);
  // u_decode true => the texture decoded sRGB->linear on sample; re-encode.
  fragColor = vec4(u_decode ? linearToSrgb(c.rgb) : c.rgb, c.a);
}`;
    this._seedProg = this.r.compileProgram(QUAD_VERT, frag);
    return this._seedProg;
  }

  /** Stamp a single soft dab into the dab coverage buffer (clears it first). */
  private stampCoverage(cx: number, cy: number, pressure: number): void {
    const dab = this.dab;
    const target = this.target;
    if (!dab || !target) return;
    const gl = this.r.gl;
    // Clear the dab buffer.
    gl.bindFramebuffer(gl.FRAMEBUFFER, dab.fbo);
    gl.viewport(0, 0, dab.width, dab.height);
    gl.disable(gl.BLEND);
    gl.clearColor(0, 0, 0, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);

    const diameter = this.params.size * pressure;
    const radius = diameter / 2;
    const x0 = cx - radius;
    const y0 = cy - radius;
    gl.useProgram(this.dabProg);
    const pixToClip = new Float32Array([
      2 / dab.width, 0, 0,
      0, 2 / dab.height, 0,
      -1, -1, 1,
    ]);
    const toPx = m3.multiply(m3.translation(x0, y0), m3.scaling(diameter, diameter));
    const transform = m3.multiply(pixToClip, toPx);
    gl.uniformMatrix3fv(gl.getUniformLocation(this.dabProg, "u_transform"), false, transform);
    gl.uniform1f(gl.getUniformLocation(this.dabProg, "u_hardness"), this.params.hardness);
    gl.uniform1f(gl.getUniformLocation(this.dabProg, "u_flow"), 1);
    const useSel = !!this.selTex;
    gl.uniform1i(gl.getUniformLocation(this.dabProg, "u_useSelection"), useSel ? 1 : 0);
    if (useSel) {
      const sx = diameter / this.docSize.width;
      const sy = diameter / this.docSize.height;
      const tx = (target.x + x0) / this.docSize.width;
      const ty = (target.y + y0) / this.docSize.height;
      const uvToSel = new Float32Array([sx, 0, 0, 0, sy, 0, tx, ty, 1]);
      gl.uniformMatrix3fv(gl.getUniformLocation(this.dabProg, "u_uvToSel"), false, uvToSel);
      gl.uniform1i(gl.getUniformLocation(this.dabProg, "u_selection"), 0);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, this.selTex);
    }
    this.r.drawQuad();
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  }

  /** Apply one dab: stamp coverage, then run the mode's apply pass (ping-pong). */
  private applyDab(cx: number, cy: number, pressure: number): void {
    const work = this.work;
    const alt = this.workAlt;
    const dab = this.dab;
    const target = this.target;
    if (!work || !alt || !dab || !target || !this.seeded) return;
    const gl = this.r.gl;
    const W = work.width;
    const H = work.height;

    // Anchor the clone offset on the first dab of a (re)anchoring stroke.
    if (this.mode === "clone" || this.mode === "heal") {
      if (this.needAnchor) {
        if (!this.cloneSource) return; // no source set — ignore the dab
        // offset = source - currentDab (so sample = current + offset = source).
        this.cloneOffset = {
          dx: this.cloneSource.x - cx,
          dy: this.cloneSource.y - cy,
        };
        this.needAnchor = false;
      }
      if (!this.cloneOffset) return;
    }

    this.stampCoverage(cx, cy, pressure);

    // Read = current work; write = alt. Then swap.
    gl.bindFramebuffer(gl.FRAMEBUFFER, alt.fbo);
    gl.viewport(0, 0, W, H);
    gl.disable(gl.BLEND);
    const prog = this.applyProgram();
    gl.useProgram(prog);
    gl.uniformMatrix3fv(
      gl.getUniformLocation(prog, "u_transform"),
      false,
      new Float32Array([2, 0, 0, 0, 2, 0, -1, -1, 1]),
    );
    gl.uniform1i(gl.getUniformLocation(prog, "u_layer"), 0);
    gl.uniform1i(gl.getUniformLocation(prog, "u_wet"), 1);
    // Working buffers are display-sRGB RGBA8 (decode = false).
    gl.uniform1i(gl.getUniformLocation(prog, "u_decodeSrc"), 0);
    this.setModeUniforms(prog, cx, cy, W, H);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, work.color.tex);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, dab.color.tex);
    this.r.drawQuad();
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);

    // Swap working buffers.
    this.work = alt;
    this.workAlt = work;
    this.prevDab = { x: cx, y: cy };
    this.edits++;
  }

  /** Whether any dab modified the working buffer this stroke (commit guard). */
  hasEdited(): boolean {
    return this.edits > 0;
  }

  private applyProgram(): WebGLProgram {
    switch (this.mode) {
      case "clone": return this.cloneProg;
      case "heal": return this.healProg;
      case "dodge":
      case "burn": return this.dodgeBurnProg;
      case "smudge": return this.smudgeProg;
      case "blur":
      case "sharpen": return this.focusProg;
    }
  }

  private setModeUniforms(prog: WebGLProgram, cx: number, cy: number, W: number, H: number): void {
    const gl = this.r.gl;
    const loc = (n: string) => gl.getUniformLocation(prog, n);
    switch (this.mode) {
      case "clone": {
        const off = this.cloneOffset!;
        // sampleUv = dstUv + (offset_layerPx / size). uv = layerPx / size.
        gl.uniform2f(loc("u_srcOffset"), off.dx / W, off.dy / H);
        gl.uniform1f(loc("u_opacity"), this.params.amount);
        break;
      }
      case "heal": {
        const off = this.cloneOffset!;
        gl.uniform2f(loc("u_srcOffset"), off.dx / W, off.dy / H);
        gl.uniform2f(loc("u_blurStep"), 1 / W, 1 / H);
        gl.uniform1f(loc("u_opacity"), this.params.amount);
        break;
      }
      case "dodge":
      case "burn": {
        gl.uniform1f(loc("u_exposure"), this.params.amount);
        gl.uniform1i(loc("u_mode"), this.mode === "burn" ? 1 : 0);
        const r = this.params.range ?? "midtones";
        gl.uniform1i(loc("u_range"), r === "shadows" ? 0 : r === "highlights" ? 2 : 1);
        break;
      }
      case "smudge": {
        // Smear from BEHIND the motion: pickup point is opposite the travel dir,
        // a fraction of the radius back. Falls back to no offset on the first dab.
        let ox = 0;
        let oy = 0;
        if (this.prevDab) {
          const dx = cx - this.prevDab.x;
          const dy = cy - this.prevDab.y;
          const len = Math.hypot(dx, dy);
          if (len > 1e-3) {
            const back = Math.min(this.params.size * 0.5, len);
            ox = (-dx / len) * back;
            oy = (-dy / len) * back;
          }
        }
        gl.uniform2f(loc("u_smearOffset"), ox / W, oy / H);
        gl.uniform1f(loc("u_strength"), this.params.amount);
        break;
      }
      case "blur":
      case "sharpen": {
        gl.uniform2f(loc("u_texel"), 1 / W, 1 / H);
        gl.uniform1f(loc("u_strength"), this.params.amount);
        gl.uniform1i(loc("u_mode"), this.mode === "sharpen" ? 1 : 0);
        break;
      }
    }
  }
}
