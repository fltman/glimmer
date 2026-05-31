/**
 * Flatten the document to a PNG Blob.
 *
 * Renders the full composite at document resolution into an offscreen RGBA8
 * target (premultiplied linear), then de-premultiplies + encodes linear->sRGB
 * on readback, and packs into a canvas for PNG encoding. This path is
 * independent of the viewport so the export is always full-resolution.
 */
import type { EditorEngine } from "./EditorEngine";
import { QUAD_VERT, BLEND_NORMAL_FRAG } from "./gl/shaders";
import * as m3 from "./math/mat3";

function linearToSrgb(c: number): number {
  if (c <= 0.0031308) return c * 12.92;
  return 1.055 * Math.pow(c, 1 / 2.4) - 0.055;
}

export async function exportPng(engine: EditorEngine): Promise<Blob> {
  const r = engine.getRenderer();
  const blend = engine.getBlendProgram();
  if (!r || !blend) throw new Error("Engine not mounted; cannot export.");
  const gl = r.gl;
  const doc = engine.doc;
  const w = Math.max(1, Math.round(doc.width));
  const h = Math.max(1, Math.round(doc.height));

  // Dedicated full-res accumulator (don't disturb the viewport one). RGBA8, not
  // float: the composite is read back as bytes for PNG encoding, and byte
  // readback from an RGBA16F FBO is an invalid combo that returns all zeros.
  const target = r.createRGBA8Target(w, h);
  gl.bindFramebuffer(gl.FRAMEBUFFER, target.fbo);
  gl.viewport(0, 0, w, h);
  gl.clearColor(0, 0, 0, 0);
  gl.clear(gl.COLOR_BUFFER_BIT);
  gl.enable(gl.BLEND);
  gl.blendFuncSeparate(
    gl.ONE,
    gl.ONE_MINUS_SRC_ALPHA,
    gl.ONE,
    gl.ONE_MINUS_SRC_ALPHA,
  );

  gl.useProgram(blend);
  const uTransform = gl.getUniformLocation(blend, "u_transform");
  const uOpacity = gl.getUniformLocation(blend, "u_opacity");
  const uTex = gl.getUniformLocation(blend, "u_tex");
  const uSrgb = gl.getUniformLocation(blend, "u_srgbSource");
  gl.uniform1i(uTex, 0);

  // Document px -> clip (no view transform; flip handled by pixelToClip).
  const pixToClip = m3.pixelToClip(w, h);
  for (const id of doc.orderBottomToTop()) {
    const layer = doc.getLayer(id);
    if (!layer || !layer.visible || layer.opacity <= 0) continue;
    const tex = engine.resolveTexturePublic(id);
    if (!tex) continue;
    const toDocPx = m3.multiply(
      m3.translation(layer.x, layer.y),
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

  // Readback (RGBA8, premultiplied linear) and convert to straight sRGB.
  const raw = r.readPixels(target, 0, 0, w, h);
  r.deleteFramebuffer(target);

  const out = new Uint8ClampedArray(w * h * 4);
  // GL reads bottom-up; flip rows while converting.
  for (let y = 0; y < h; y++) {
    const srcRow = (h - 1 - y) * w * 4;
    const dstRow = y * w * 4;
    for (let x = 0; x < w * 4; x += 4) {
      const a = raw[srcRow + x + 3]! / 255;
      const inv = a > 0.0001 ? 1 / a : 0;
      for (let ch = 0; ch < 3; ch++) {
        const linPremul = raw[srcRow + x + ch]! / 255;
        const lin = linPremul * inv; // un-premultiply
        out[dstRow + x + ch] = Math.round(linearToSrgb(lin) * 255);
      }
      out[dstRow + x + 3] = raw[srcRow + x + 3]!;
    }
  }

  const imageData = new ImageData(out, w, h);
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
