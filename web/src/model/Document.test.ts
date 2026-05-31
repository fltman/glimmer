import { describe, it, expect } from "vitest";
import {
  Document,
  BLEND_MODE_INDEX,
  BLEND_MODE_LABELS,
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
    expect(doc.getLayer(id)!.x).toBe(3);
    expect(doc.getLayer(id)!.y).toBe(5);
    doc.addMask(id);
    const snap = doc.snapshot();
    expect(snap.layers[0]!.hasMask).toBe(true);
    expect(snap.layers[0]!.maskEnabled).toBe(true);
  });
});
