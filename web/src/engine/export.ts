/**
 * Flatten the document to an image Blob (PNG / JPEG / WebP).
 *
 * Renders the full composite at document resolution into an offscreen RGBA8
 * target (premultiplied linear), then de-premultiplies + encodes linear->sRGB
 * on readback, and packs into a canvas for encoding. This path is independent of
 * the viewport so the export is always full-resolution.
 *
 * PNG keeps the alpha channel. JPEG and WebP are flattened onto a matte color
 * (white by default) because those formats are opaque — transparent pixels are
 * composited over the matte before encoding.
 */
import type { EditorEngine } from "./EditorEngine";

function linearToSrgb(c: number): number {
  if (c <= 0.0031308) return c * 12.92;
  return 1.055 * Math.pow(c, 1 / 2.4) - 0.055;
}

export type ExportFormat = "png" | "jpeg" | "webp";

export interface ExportOptions {
  format: ExportFormat;
  /** 0..1 quality for lossy formats (jpeg/webp). Default 0.92. */
  quality?: number;
  /** Matte color (straight sRGB 0..1) for opaque formats. Default white. */
  matte?: { r: number; g: number; b: number };
}

const MIME: Record<ExportFormat, string> = {
  png: "image/png",
  jpeg: "image/jpeg",
  webp: "image/webp",
};

/**
 * Flatten + encode the document. PNG preserves alpha; JPEG/WebP composite over
 * the matte (white unless overridden). Returns the encoded Blob.
 */
export async function exportImage(
  engine: EditorEngine,
  opts: ExportOptions,
): Promise<Blob> {
  const r = engine.getRenderer();
  if (!r) throw new Error("Engine not mounted; cannot export.");
  const doc = engine.doc;
  const w = Math.max(1, Math.round(doc.width));
  const h = Math.max(1, Math.round(doc.height));

  // Composite the full document (raster + adjustment + group + effect layers) at
  // doc resolution into an RGBA8 target (premultiplied linear) via the engine's
  // fold. RGBA8, not float: byte readback from an RGBA16F FBO returns zeros.
  const target = engine.renderDocumentComposite();
  if (!target) throw new Error("Engine not ready; cannot export.");

  const raw = r.readPixels(target, 0, 0, w, h);
  r.deleteFramebuffer(target);

  const opaque = opts.format !== "png";
  const matte = opts.matte ?? { r: 1, g: 1, b: 1 };

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
        let srgb = linearToSrgb(lin);
        if (opaque) {
          // Composite straight color over the matte by alpha (display sRGB).
          const matteCh = ch === 0 ? matte.r : ch === 1 ? matte.g : matte.b;
          srgb = srgb * a + matteCh * (1 - a);
        }
        out[dstRow + x + ch] = Math.round(srgb * 255);
      }
      out[dstRow + x + 3] = opaque ? 255 : raw[srcRow + x + 3]!;
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

  const mime = MIME[opts.format];
  const quality = opts.quality ?? 0.92;

  if (canvas instanceof OffscreenCanvas) {
    return canvas.convertToBlob({ type: mime, quality });
  }
  return new Promise<Blob>((resolve, reject) => {
    (canvas as HTMLCanvasElement).toBlob(
      (b) => (b ? resolve(b) : reject(new Error("toBlob failed"))),
      mime,
      quality,
    );
  });
}

/** Flatten the document to a PNG Blob (alpha preserved). */
export async function exportPng(engine: EditorEngine): Promise<Blob> {
  return exportImage(engine, { format: "png" });
}
