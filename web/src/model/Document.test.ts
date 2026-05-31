import { describe, it, expect } from "vitest";
import {
  Document,
  BLEND_MODE_INDEX,
  BLEND_MODE_LABELS,
  isRasterLayer,
  isTextLayer,
  isPixelLayer,
  type BlendMode,
} from "./Document";

/** A minimal raster source stub (Document only reads width/height). */
function src(width: number, height: number): ImageData {
  return { width, height, data: new Uint8ClampedArray(width * height * 4) } as ImageData;
}

describe("Document blend-mode contract", () => {
  it("every blend mode has a unique shader index and a label", () => {
    const indices = Object.values(BLEND_MODE_INDEX);
    expect(new Set(indices).size).toBe(indices.length); // unique
    // Indices are contiguous 0..N-1 (the shader switch relies on this).
    const sorted = [...indices].sort((a, b) => a - b);
    sorted.forEach((v, i) => expect(v).toBe(i));
    // Every mode is presented in the dropdown.
    const labeled = new Set(BLEND_MODE_LABELS.map((b) => b.mode));
    for (const mode of Object.keys(BLEND_MODE_INDEX) as BlendMode[]) {
      expect(labeled.has(mode)).toBe(true);
    }
  });
});

describe("Document layer masks", () => {
  it("adds a fully-visible mask and toggles/removes it", () => {
    const doc = new Document(8, 8);
    const data = src(4, 4);
    const id = doc.addRasterLayer(data, "L");
    expect(doc.addMask(id)).toBe(true);
    const layer = doc.getLayer(id)!;
    expect(layer.mask?.width).toBe(4);
    expect(layer.mask?.data.every((v) => v === 255)).toBe(true);
    expect(doc.addMask(id)).toBe(false); // already has one

    doc.setMaskEnabled(id, false);
    expect(doc.getLayer(id)!.mask?.enabled).toBe(false);

    const before = doc.getLayer(id)!.mask!.version;
    doc.bumpMaskVersion(id);
    expect(doc.getLayer(id)!.mask!.version).toBe(before + 1);

    doc.removeMask(id);
    expect(doc.getLayer(id)!.mask).toBeUndefined();
  });

  it("snapshot reflects mask presence + position changes", () => {
    const doc = new Document(8, 8);
    const id = doc.addRasterLayer(src(4, 4));
    doc.setPosition(id, 3, 5);
    const moved = doc.getLayer(id)!;
    expect(isRasterLayer(moved) && moved.x).toBe(3);
    expect(isRasterLayer(moved) && moved.y).toBe(5);
    doc.addMask(id);
    const snap = doc.snapshot();
    expect(snap.layers[0]!.hasMask).toBe(true);
    expect(snap.layers[0]!.maskEnabled).toBe(true);
  });
});

describe("Document text layers", () => {
  it("adds a text layer, snapshots its params, and derives its name", () => {
    const doc = new Document(64, 64);
    const id = doc.addTextLayer(10, 12, { text: "Hello\nWorld", fontSize: 32 });
    const layer = doc.getLayer(id)!;
    expect(isTextLayer(layer)).toBe(true);
    expect(isPixelLayer(layer)).toBe(true);
    expect(layer.name).toBe("Hello"); // first line
    const snap = doc.snapshot();
    expect(snap.layers[0]!.kind).toBe("text");
    expect(snap.layers[0]!.text?.text).toBe("Hello\nWorld");
    expect(snap.layers[0]!.text?.fontSize).toBe(32);
  });

  it("updateTextLayer bumps version and re-derives the name", () => {
    const doc = new Document(64, 64);
    const id = doc.addTextLayer(0, 0, { text: "a" });
    const v0 = doc.getTextLayerParams(id);
    doc.updateTextLayer(id, { text: "Renamed line" });
    const layer = doc.getLayer(id)!;
    expect(layer.name).toBe("Renamed line");
    expect(isTextLayer(layer) && layer.version).toBeGreaterThan(1);
    expect(v0!.text).toBe("a");
  });

  it("bakes a text layer to raster (same id) and unbakes back", () => {
    const doc = new Document(64, 64);
    const id = doc.addTextLayer(5, 5, { text: "T" });
    const params = doc.getTextLayerParams(id)!;
    const baked = { width: 20, height: 10, data: new Uint8ClampedArray(20 * 10 * 4) } as ImageData;
    doc.bakeTextToRaster(id, baked, 3, 4);
    const r = doc.getLayer(id)!;
    expect(isRasterLayer(r)).toBe(true);
    expect(isRasterLayer(r) && r.width).toBe(20);
    expect(isRasterLayer(r) && r.x).toBe(3);
    // Unbake restores an editable text layer with the same id + params.
    doc.unbakeTextFromRaster(id, params, 5, 5);
    const t = doc.getLayer(id)!;
    expect(isTextLayer(t)).toBe(true);
    expect(isTextLayer(t) && t.text).toBe("T");
    expect(isTextLayer(t) && t.x).toBe(5);
  });

  it("setPosition moves text layers (not just raster)", () => {
    const doc = new Document(64, 64);
    const id = doc.addTextLayer(0, 0, { text: "x" });
    doc.setPosition(id, 11, 22);
    const t = doc.getLayer(id)!;
    expect(isPixelLayer(t) && t.x).toBe(11);
    expect(isPixelLayer(t) && t.y).toBe(22);
  });
});
