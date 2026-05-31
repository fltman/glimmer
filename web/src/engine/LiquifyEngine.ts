/**
 * LiquifyEngine — a modal warp SESSION on the active raster layer.
 *
 * The session maintains a per-layer DISPLACEMENT MAP: a layer-sized RGBA16F
 * (float) target whose RG channels store, per pixel, the offset (in LAYER
 * PIXELS) applied when sampling the layer. Identity = zero displacement. The
 * on-screen preview (and the final bake) sample the layer THROUGH this map: a
 * fragment at layer uv `p` shows the layer pixel at `p + disp(p)/size`.
 *
 * Each brush dab is a whole-map read-modify-write, ping-ponging two float
 * targets with BLEND DISABLED — hardware float blend is silently dropped on
 * Chrome/ANGLE macOS (no EXT_float_blend), so the dab shader reads the prior
 * displacement as a texture and outputs the combined result. Strokes interpolate
 * dabs along the path (spacing ~ a fraction of the radius) so drags are smooth.
 *
 * The engine resolves textures, so EditorEngine seeds the layer texture handle
 * (begin + seed mirror the RetouchEngine contract). LiquifyEngine never reads
 * back or touches the Document; EditorEngine bakes the result on commit.
 */
import type { WebGL2Renderer, FramebufferHandle, TextureHandle } from "./gl/Renderer";
import { QUAD_VERT, LIQUIFY_DAB_FRAG, LIQUIFY_PREVIEW_FRAG } from "./gl/shaders";

/** The Liquify warp tools. */
export type LiquifyMode =
  | "forward_warp"
  | "bloat"
  | "pucker"
  | "twirl_left"
  | "twirl_right"
  | "reconstruct";

/** Numeric mode indices shared with LIQUIFY_DAB_FRAG (keep in sync). */
const MODE_INDEX: Record<LiquifyMode, number> = {
  forward_warp: 0,
  bloat: 1,
  pucker: 2,
  twirl_left: 3,
  twirl_right: 4,
  reconstruct: 5,
};

/** Per-mode strength gain so all tools feel comparable at the same pressure. */
const MODE_GAIN: Record<LiquifyMode, number> = {
  forward_warp: 1.0,
  bloat: 0.18,
  pucker: 0.18,
  twirl_left: 0.5,
  twirl_right: 0.5,
  reconstruct: 0.35,
};

interface LiquifyTarget {
  /** Layer-local size of the displacement map (== layer px). */
  width: number;
  height: number;
  /** Top-left of the layer in document space (for selection sampling). */
  x: number;
  y: number;
}

export interface LiquifyBrush {
  /** Diameter in layer px. */
  size: number;
  /** 0..1 pressure scaling (defaults to 1 when not pen-driven). */
  pressure?: number;
}

export class LiquifyEngine {
  private r: WebGL2Renderer;
  private dabProg: WebGLProgram;
  private previewProg: WebGLProgram;

  /** Ping-pong displacement maps (RGBA16F; RG = offset in layer px). `disp` is current. */
  private disp: FramebufferHandle | null = null;
  private dispAlt: FramebufferHandle | null = null;

  private active = false;
  private target: LiquifyTarget | null = null;
  /** The layer texture handle to warp (seeded by the engine after begin). */
  private layerTex: TextureHandle | null = null;
  /** Number of dabs that actually moved the map (commit guard). */
  private edits = 0;

  // Selection constraint.
  private selTex: WebGLTexture | null = null;
  private docSize = { width: 1, height: 1 };

  constructor(renderer: WebGL2Renderer) {
    this.r = renderer;
    this.dabProg = renderer.compileProgram(QUAD_VERT, LIQUIFY_DAB_FRAG);
    this.previewProg = renderer.compileProgram(QUAD_VERT, LIQUIFY_PREVIEW_FRAG);
  }

  get isActive(): boolean {
    return this.active;
  }
  /** The current displacement map (for the warped preview / bake), or null. */
  get displacementTexture(): TextureHandle | null {
    return this.disp?.color ?? null;
  }
  /** The seeded layer texture being warped, or null. */
  get sourceTexture(): TextureHandle | null {
    return this.layerTex;
  }
  /** Layer-local size of the active session, or null. */
  get size(): { width: number; height: number } | null {
    return this.target ? { width: this.target.width, height: this.target.height } : null;
  }
  /** Whether any dab moved the displacement map this session. */
  hasEdited(): boolean {
    return this.edits > 0;
  }

  /**
   * Begin a Liquify session covering `target` (layer-local). `selTex` (optional)
   * constrains the warp to the document selection; `docSize` is the selection
   * texture size. Resets the displacement map to identity.
   */
  begin(
    target: LiquifyTarget,
    selTex: WebGLTexture | null,
    docSize: { width: number; height: number },
  ): void {
    this.ensureBuffers(target.width, target.height);
    this.clearIdentity();
    this.active = true;
    this.target = target;
    this.selTex = selTex;
    this.docSize = docSize;
    this.layerTex = null;
    this.edits = 0;
  }

  /** Store the layer texture handle to warp (engine resolves it, then calls this). */
  seed(layerTex: TextureHandle): void {
    this.layerTex = layerTex;
  }

  /**
   * Apply Liquify under the brush, interpolating dabs from the previous sample
   * to (cx,cy). `dx`,`dy` are the pointer motion (layer px) used by forward warp;
   * the engine passes the per-coalesced-event delta. Spacing keeps strokes
   * smooth without flooding the GPU with redundant whole-map passes.
   */
  apply(
    cx: number,
    cy: number,
    dx: number,
    dy: number,
    mode: LiquifyMode,
    brush: LiquifyBrush,
  ): void {
    if (!this.active || !this.disp || !this.target) return;
    const pressure = brush.pressure && brush.pressure > 0 ? brush.pressure : 1;
    const radius = Math.max(1, (brush.size * pressure) / 2);
    const mi = MODE_INDEX[mode];
    // Per-stamp strength: when a long drag is subdivided, each sub-stamp gets a
    // share so accumulating bloat/pucker/twirl along the path doesn't explode.
    const baseStrength = MODE_GAIN[mode] * pressure;

    // Walk from the previous point to (cx,cy), stamping along the path so the
    // warp is continuous (every mode is dragged across the image, not just at
    // the endpoints). Spacing ~25% of the radius keeps strokes smooth.
    const dist = Math.hypot(dx, dy);
    const spacing = Math.max(1, radius * 0.25);
    if (dist <= spacing) {
      this.stampDab(cx, cy, dx, dy, radius, baseStrength, mi);
      return;
    }
    const steps = Math.min(64, Math.ceil(dist / spacing));
    // Forward warp pushes by the WHOLE motion split across sub-stamps; the other
    // modes apply their point effect at reduced per-stamp strength so the
    // dragged total feels comparable to a single press.
    const stepStrength = mode === "forward_warp" ? baseStrength : baseStrength / Math.sqrt(steps);
    const sx = cx - dx;
    const sy = cy - dy;
    const segDx = dx / steps;
    const segDy = dy / steps;
    for (let i = 1; i <= steps; i++) {
      const px = sx + segDx * i;
      const py = sy + segDy * i;
      this.stampDab(px, py, segDx, segDy, radius, stepStrength, mi);
    }
  }

  /** Relax the WHOLE map back toward identity (Restore All in the modal). */
  reconstructAll(amount = 1): void {
    if (!this.active || !this.disp || !this.target) return;
    // A single full-coverage reconstruct dab centered with an enormous radius
    // pulls every pixel toward identity by `amount`.
    const W = this.target.width;
    const H = this.target.height;
    this.stampDab(
      W / 2,
      H / 2,
      0,
      0,
      Math.max(W, H) * 2,
      Math.max(0, Math.min(1, amount)),
      MODE_INDEX.reconstruct,
    );
  }

  /** End the session (engine bakes/reads back before calling this). */
  end(): void {
    this.active = false;
    this.target = null;
    this.layerTex = null;
    this.selTex = null;
  }

  dispose(): void {
    if (this.disp) this.r.deleteFramebuffer(this.disp);
    if (this.dispAlt) this.r.deleteFramebuffer(this.dispAlt);
    this.disp = this.dispAlt = null;
  }

  // ── internals ───────────────────────────────────────────
  private ensureBuffers(w: number, h: number): void {
    const W = Math.max(1, w);
    const H = Math.max(1, h);
    if (this.disp && this.disp.width === W && this.disp.height === H) return;
    if (this.disp) this.r.deleteFramebuffer(this.disp);
    if (this.dispAlt) this.r.deleteFramebuffer(this.dispAlt);
    // RGBA16F (createColorTarget) when float targets exist; the RGBA8 fallback
    // can't store signed offsets, so the warp range is then limited — but the map
    // still functions (offsets are small fractions). Float is the common path.
    this.disp = this.r.createColorTarget(W, H);
    this.dispAlt = this.r.createColorTarget(W, H);
  }

  /** Clear both maps to identity (RG = 0 displacement). */
  private clearIdentity(): void {
    const gl = this.r.gl;
    for (const fb of [this.disp, this.dispAlt]) {
      if (!fb) continue;
      gl.bindFramebuffer(gl.FRAMEBUFFER, fb.fbo);
      gl.viewport(0, 0, fb.width, fb.height);
      gl.disable(gl.BLEND);
      gl.clearColor(0, 0, 0, 1);
      gl.clear(gl.COLOR_BUFFER_BIT);
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  }

  /**
   * One dab = a whole-map read-modify-write: read `disp`, write `dispAlt`
   * (blend disabled, in-shader), then swap. `motion` is the layer-px motion for
   * forward warp; the falloff/strength shape every mode.
   */
  private stampDab(
    cx: number,
    cy: number,
    motionX: number,
    motionY: number,
    radius: number,
    strength: number,
    modeIndex: number,
  ): void {
    const disp = this.disp;
    const alt = this.dispAlt;
    const target = this.target;
    if (!disp || !alt || !target) return;
    const gl = this.r.gl;
    const W = disp.width;
    const H = disp.height;
    const prog = this.dabProg;

    gl.bindFramebuffer(gl.FRAMEBUFFER, alt.fbo);
    gl.viewport(0, 0, W, H);
    gl.disable(gl.BLEND);
    gl.useProgram(prog);
    gl.uniformMatrix3fv(
      gl.getUniformLocation(prog, "u_transform"),
      false,
      new Float32Array([2, 0, 0, 0, 2, 0, -1, -1, 1]),
    );
    gl.uniform1i(gl.getUniformLocation(prog, "u_disp"), 0);
    gl.uniform2f(gl.getUniformLocation(prog, "u_size"), W, H);
    gl.uniform2f(gl.getUniformLocation(prog, "u_center"), cx, cy);
    gl.uniform1f(gl.getUniformLocation(prog, "u_radius"), radius);
    gl.uniform2f(gl.getUniformLocation(prog, "u_motion"), motionX, motionY);
    gl.uniform1f(gl.getUniformLocation(prog, "u_strength"), strength);
    gl.uniform1i(gl.getUniformLocation(prog, "u_mode"), modeIndex);

    const useSel = !!this.selTex;
    gl.uniform1i(gl.getUniformLocation(prog, "u_useSelection"), useSel ? 1 : 0);
    if (useSel) {
      // map uv [0,1] -> layer px -> doc px -> selection uv.
      const sx = W / this.docSize.width;
      const sy = H / this.docSize.height;
      const tx = target.x / this.docSize.width;
      const ty = target.y / this.docSize.height;
      const uvToSel = new Float32Array([sx, 0, 0, 0, sy, 0, tx, ty, 1]);
      gl.uniformMatrix3fv(gl.getUniformLocation(prog, "u_uvToSel"), false, uvToSel);
      gl.uniform1i(gl.getUniformLocation(prog, "u_selection"), 1);
      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_2D, this.selTex);
    }

    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, disp.color.tex);
    this.r.drawQuad();
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);

    // Swap so `disp` holds the updated map.
    this.disp = alt;
    this.dispAlt = disp;
    this.edits++;
  }

  /**
   * Sample the seeded layer through the current displacement into `dst`. When
   * `premul`, the output is premultiplied LINEAR (for the live preview composite
   * over the backdrop); otherwise straight-alpha DISPLAY-sRGB (for the RGBA8
   * bake readback). `dst` must match the layer size. Returns false if not ready.
   */
  renderWarp(dst: FramebufferHandle, premul: boolean): boolean {
    const disp = this.disp;
    const tex = this.layerTex;
    const target = this.target;
    if (!disp || !tex || !target) return false;
    const gl = this.r.gl;
    const prog = this.previewProg;
    gl.bindFramebuffer(gl.FRAMEBUFFER, dst.fbo);
    gl.viewport(0, 0, dst.width, dst.height);
    gl.disable(gl.BLEND);
    if (!premul) {
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
    }
    gl.useProgram(prog);
    gl.uniformMatrix3fv(
      gl.getUniformLocation(prog, "u_transform"),
      false,
      new Float32Array([2, 0, 0, 0, 2, 0, -1, -1, 1]),
    );
    gl.uniform1i(gl.getUniformLocation(prog, "u_layer"), 0);
    gl.uniform1i(gl.getUniformLocation(prog, "u_disp"), 1);
    gl.uniform2f(gl.getUniformLocation(prog, "u_size"), disp.width, disp.height);
    gl.uniform1i(gl.getUniformLocation(prog, "u_srgbLayer"), tex.srgb ? 1 : 0);
    gl.uniform1i(gl.getUniformLocation(prog, "u_premul"), premul ? 1 : 0);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, tex.tex);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, disp.color.tex);
    this.r.drawQuad();
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    return true;
  }
}
