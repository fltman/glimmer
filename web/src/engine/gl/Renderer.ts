/**
 * Thin renderer abstraction + WebGL2 implementation.
 *
 * The engine only ever calls through the `Renderer` interface so a WebGPU
 * backend can be swapped in later (per the plan) without touching compositing
 * logic. Keep this layer small but correct — it owns raw GL state.
 */

export interface TextureHandle {
  /** Underlying GL texture. */
  readonly tex: WebGLTexture;
  readonly width: number;
  readonly height: number;
  /** True if uploaded as SRGB8_ALPHA8 (GPU decodes to linear on sample). */
  readonly srgb: boolean;
}

export interface FramebufferHandle {
  readonly fbo: WebGLFramebuffer;
  readonly color: TextureHandle;
  readonly width: number;
  readonly height: number;
}

export interface Renderer {
  readonly gl: WebGL2RenderingContext;
  /** Whether RGBA16F float render targets are available. */
  readonly floatTargets: boolean;
  compileProgram(vert: string, frag: string): WebGLProgram;
  createTextureFromSource(
    source: TexImageSource,
    opts?: { srgb?: boolean },
  ): TextureHandle;
  createColorTarget(width: number, height: number): FramebufferHandle;
  /**
   * RGBA8 (8-bit UNORM) color target. Required whenever the result is read back
   * with readPixels (RGBA/UNSIGNED_BYTE): byte readback from an RGBA16F float
   * FBO is an invalid format combination and yields all-zero pixels. Stores
   * already-sRGB-encoded bytes verbatim (no SRGB re-encode).
   */
  createRGBA8Target(width: number, height: number): FramebufferHandle;
  /** Single-channel (R8) render target for selection / mask buffers. */
  createR8Target(width: number, height: number): FramebufferHandle;
  /** Upload a single-channel (R8) texture from a raw byte buffer. */
  createR8Texture(
    data: Uint8Array | null,
    width: number,
    height: number,
  ): TextureHandle;
  /** Upload a straight-alpha RGBA8 texture from raw bytes (no sRGB decode). */
  createRGBA8Texture(
    data: Uint8Array | null,
    width: number,
    height: number,
    opts?: { srgb?: boolean },
  ): TextureHandle;
  deleteTexture(t: TextureHandle): void;
  deleteFramebuffer(f: FramebufferHandle): void;
  /** Read RGBA8 pixels back from the currently bound framebuffer region. */
  readPixels(
    fb: FramebufferHandle | null,
    x: number,
    y: number,
    w: number,
    h: number,
  ): Uint8Array;
  resizeDrawingBuffer(w: number, h: number): void;
}

const QUAD_VERTS = new Float32Array([
  // pos    uv
  0, 0, 0, 0, 1, 0, 1, 0, 0, 1, 0, 1, 1, 0, 1, 0, 1, 1, 1, 1, 0, 1, 0, 1,
]);

export class WebGL2Renderer implements Renderer {
  readonly gl: WebGL2RenderingContext;
  readonly floatTargets: boolean;
  private quadVao: WebGLVertexArrayObject;
  private quadVbo: WebGLBuffer;

  constructor(canvas: HTMLCanvasElement) {
    const gl = canvas.getContext("webgl2", {
      alpha: true,
      premultipliedAlpha: true,
      antialias: false,
      powerPreference: "high-performance",
      preserveDrawingBuffer: false,
    });
    if (!gl) throw new Error("WebGL2 is not available in this browser.");
    this.gl = gl;

    // Float render targets are gated behind this extension; the linear
    // accumulator falls back to RGBA8 when absent.
    const ext = gl.getExtension("EXT_color_buffer_float");
    this.floatTargets = !!ext;

    // Shared fullscreen/unit quad geometry.
    const vbo = gl.createBuffer();
    if (!vbo) throw new Error("Failed to create quad VBO");
    this.quadVbo = vbo;
    const vao = gl.createVertexArray();
    if (!vao) throw new Error("Failed to create quad VAO");
    this.quadVao = vao;

    gl.bindVertexArray(vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
    gl.bufferData(gl.ARRAY_BUFFER, QUAD_VERTS, gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 16, 0);
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 2, gl.FLOAT, false, 16, 8);
    gl.bindVertexArray(null);
  }

  compileProgram(vert: string, frag: string): WebGLProgram {
    const gl = this.gl;
    const compile = (type: number, src: string): WebGLShader => {
      const sh = gl.createShader(type);
      if (!sh) throw new Error("createShader failed");
      gl.shaderSource(sh, src);
      gl.compileShader(sh);
      if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
        const log = gl.getShaderInfoLog(sh);
        gl.deleteShader(sh);
        throw new Error(`Shader compile error: ${log}`);
      }
      return sh;
    };
    const vs = compile(gl.VERTEX_SHADER, vert);
    const fs = compile(gl.FRAGMENT_SHADER, frag);
    const prog = gl.createProgram();
    if (!prog) throw new Error("createProgram failed");
    gl.attachShader(prog, vs);
    gl.attachShader(prog, fs);
    gl.linkProgram(prog);
    gl.deleteShader(vs);
    gl.deleteShader(fs);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
      const log = gl.getProgramInfoLog(prog);
      gl.deleteProgram(prog);
      throw new Error(`Program link error: ${log}`);
    }
    return prog;
  }

  createTextureFromSource(
    source: TexImageSource,
    opts: { srgb?: boolean } = {},
  ): TextureHandle {
    const gl = this.gl;
    const srgb = opts.srgb ?? true;
    const tex = gl.createTexture();
    if (!tex) throw new Error("createTexture failed");
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    // sRGB source: SRGB8_ALPHA8 makes the GPU decode to linear on sample.
    const internal = srgb ? gl.SRGB8_ALPHA8 : gl.RGBA8;
    gl.texImage2D(
      gl.TEXTURE_2D,
      0,
      internal,
      gl.RGBA,
      gl.UNSIGNED_BYTE,
      source,
    );
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.bindTexture(gl.TEXTURE_2D, null);
    const width =
      (source as { width?: number }).width ??
      (source as { videoWidth?: number }).videoWidth ??
      0;
    const height =
      (source as { height?: number }).height ??
      (source as { videoHeight?: number }).videoHeight ??
      0;
    return { tex, width, height, srgb };
  }

  createColorTarget(width: number, height: number): FramebufferHandle {
    const gl = this.gl;
    const tex = gl.createTexture();
    if (!tex) throw new Error("createTexture (target) failed");
    gl.bindTexture(gl.TEXTURE_2D, tex);
    if (this.floatTargets) {
      gl.texImage2D(
        gl.TEXTURE_2D,
        0,
        gl.RGBA16F,
        width,
        height,
        0,
        gl.RGBA,
        gl.HALF_FLOAT,
        null,
      );
    } else {
      // RGBA8 fallback — present pass dithers to mask banding.
      gl.texImage2D(
        gl.TEXTURE_2D,
        0,
        gl.RGBA8,
        width,
        height,
        0,
        gl.RGBA,
        gl.UNSIGNED_BYTE,
        null,
      );
    }
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

    const fbo = gl.createFramebuffer();
    if (!fbo) throw new Error("createFramebuffer failed");
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.framebufferTexture2D(
      gl.FRAMEBUFFER,
      gl.COLOR_ATTACHMENT0,
      gl.TEXTURE_2D,
      tex,
      0,
    );
    const status = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.bindTexture(gl.TEXTURE_2D, null);
    if (status !== gl.FRAMEBUFFER_COMPLETE) {
      throw new Error(`Framebuffer incomplete: 0x${status.toString(16)}`);
    }
    return {
      fbo,
      color: { tex, width, height, srgb: false },
      width,
      height,
    };
  }

  createRGBA8Target(width: number, height: number): FramebufferHandle {
    const gl = this.gl;
    const tex = gl.createTexture();
    if (!tex) throw new Error("createTexture (RGBA8 target) failed");
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texImage2D(
      gl.TEXTURE_2D,
      0,
      gl.RGBA8,
      width,
      height,
      0,
      gl.RGBA,
      gl.UNSIGNED_BYTE,
      null,
    );
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

    const fbo = gl.createFramebuffer();
    if (!fbo) throw new Error("createFramebuffer (RGBA8) failed");
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.framebufferTexture2D(
      gl.FRAMEBUFFER,
      gl.COLOR_ATTACHMENT0,
      gl.TEXTURE_2D,
      tex,
      0,
    );
    const status = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.bindTexture(gl.TEXTURE_2D, null);
    if (status !== gl.FRAMEBUFFER_COMPLETE) {
      throw new Error(`Framebuffer (RGBA8) incomplete: 0x${status.toString(16)}`);
    }
    return {
      fbo,
      color: { tex, width, height, srgb: false },
      width,
      height,
    };
  }

  createR8Target(width: number, height: number): FramebufferHandle {
    const gl = this.gl;
    const tex = gl.createTexture();
    if (!tex) throw new Error("createTexture (R8 target) failed");
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texImage2D(
      gl.TEXTURE_2D,
      0,
      gl.R8,
      width,
      height,
      0,
      gl.RED,
      gl.UNSIGNED_BYTE,
      null,
    );
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

    const fbo = gl.createFramebuffer();
    if (!fbo) throw new Error("createFramebuffer (R8) failed");
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.framebufferTexture2D(
      gl.FRAMEBUFFER,
      gl.COLOR_ATTACHMENT0,
      gl.TEXTURE_2D,
      tex,
      0,
    );
    const status = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.bindTexture(gl.TEXTURE_2D, null);
    if (status !== gl.FRAMEBUFFER_COMPLETE) {
      throw new Error(`R8 framebuffer incomplete: 0x${status.toString(16)}`);
    }
    return { fbo, color: { tex, width, height, srgb: false }, width, height };
  }

  createR8Texture(
    data: Uint8Array | null,
    width: number,
    height: number,
  ): TextureHandle {
    const gl = this.gl;
    const tex = gl.createTexture();
    if (!tex) throw new Error("createR8Texture failed");
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.texImage2D(
      gl.TEXTURE_2D,
      0,
      gl.R8,
      width,
      height,
      0,
      gl.RED,
      gl.UNSIGNED_BYTE,
      data,
    );
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 4);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.bindTexture(gl.TEXTURE_2D, null);
    return { tex, width, height, srgb: false };
  }

  createRGBA8Texture(
    data: Uint8Array | null,
    width: number,
    height: number,
    opts: { srgb?: boolean } = {},
  ): TextureHandle {
    const gl = this.gl;
    const srgb = opts.srgb ?? false;
    const tex = gl.createTexture();
    if (!tex) throw new Error("createRGBA8Texture failed");
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    gl.texImage2D(
      gl.TEXTURE_2D,
      0,
      srgb ? gl.SRGB8_ALPHA8 : gl.RGBA8,
      width,
      height,
      0,
      gl.RGBA,
      gl.UNSIGNED_BYTE,
      data,
    );
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.bindTexture(gl.TEXTURE_2D, null);
    return { tex, width, height, srgb };
  }

  /** Read back a single-channel (R8) region as raw bytes. */
  readR8(
    fb: FramebufferHandle,
    x: number,
    y: number,
    w: number,
    h: number,
  ): Uint8Array {
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, fb.fbo);
    gl.pixelStorei(gl.PACK_ALIGNMENT, 1);
    const out = new Uint8Array(w * h);
    gl.readPixels(x, y, w, h, gl.RED, gl.UNSIGNED_BYTE, out);
    gl.pixelStorei(gl.PACK_ALIGNMENT, 4);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    return out;
  }

  /** Bind program + quad VAO and draw the unit quad. Caller sets uniforms. */
  drawQuad(): void {
    const gl = this.gl;
    gl.bindVertexArray(this.quadVao);
    gl.drawArrays(gl.TRIANGLES, 0, 6);
    gl.bindVertexArray(null);
  }

  deleteTexture(t: TextureHandle): void {
    this.gl.deleteTexture(t.tex);
  }

  deleteFramebuffer(f: FramebufferHandle): void {
    this.gl.deleteFramebuffer(f.fbo);
    this.gl.deleteTexture(f.color.tex);
  }

  readPixels(
    fb: FramebufferHandle | null,
    x: number,
    y: number,
    w: number,
    h: number,
  ): Uint8Array {
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, fb ? fb.fbo : null);
    const out = new Uint8Array(w * h * 4);
    gl.readPixels(x, y, w, h, gl.RGBA, gl.UNSIGNED_BYTE, out);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    return out;
  }

  resizeDrawingBuffer(w: number, h: number): void {
    const canvas = this.gl.canvas as HTMLCanvasElement;
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
    }
  }
}
