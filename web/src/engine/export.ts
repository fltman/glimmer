/**
 * Flatten the document to a PNG Blob.
 *
 * Renders the full composite at document resolution into an offscreen RGBA8
 * target (premultiplied linear), then de-premultiplies + encodes linear->sRGB
 * on readback, and packs into a canvas for PNG encoding. This path is
 * independent of the viewport so the export is always full-resolution.
 */
import type { EditorEngine } from "./EditorEngine";

function linearToSrgb(c: number): number {
  if (c <= 0.0031308) return c * 12.92;
  return 1.055 * Math.pow(c, 1 / 2.4) - 0.055;
}

export async function exportPng(engine: EditorEngine): Promise<Blob> {
  const r = engine.getRenderer();
  if (!r) throw new Error("Engine not mounted; cannot export.");
  const doc = engine.doc;
  const w = Math.max(1, Math.round(doc.width));
  const h = Math.max(1, Math.round(doc.height));

  // Composite the full document (raster + adjustment layers) at doc resolution
  // into an RGBA8 target (premultiplied linear) via the engine's fold. RGBA8,
  // not float: byte readback from an RGBA16F FBO returns all zeros.
  const target = engine.renderDocumentComposite();
  if (!target) throw new Error("Engine not ready; cannot export.");

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
