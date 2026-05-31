import { describe, it, expect } from "vitest";
import {
  Document,
  BLEND_MODE_INDEX,
  BLEND_MODE_LABELS,
  isRasterLayer,
  isTextLayer,
  isPixelLayer,
  isSmartLayer,
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

describe("Document smart objects", () => {
  it("wraps a raster into a smart object preserving id/blend/mask + identity footprint", () => {
    const doc = new Document(64, 64);
    const id = doc.addRasterLayer(
      { width: 20, height: 10, data: new Uint8ClampedArray(20 * 10 * 4) } as ImageData,
      "L",
      { x: 5, y: 7 },
    );
    doc.setBlendMode(id, "multiply");
    doc.addMask(id);
    doc.wrapAsSmartObject(
      id,
      { width: 20, height: 10, data: new Uint8ClampedArray(20 * 10 * 4) } as ImageData,
      5,
      7,
    );
    const s = doc.getLayer(id)!;
    expect(isSmartLayer(s)).toBe(true);
    if (!isSmartLayer(s)) return;
    expect(s.blendMode).toBe("multiply"); // continuity through the wrap
    expect(!!s.mask).toBe(true);
    expect(s.naturalWidth).toBe(20);
    expect(s.naturalHeight).toBe(10);
    // Identity transform places the original at (x,y) at natural scale.
    expect(s.transform).toMatchObject({ tx: 5, ty: 7, sx: 1, sy: 1, rot: 0 });
    expect(s.width).toBe(20);
    expect(s.height).toBe(10);
    // It is a pixel layer (so masks/effects/clip/move/export all reuse raster paths).
    expect(isPixelLayer(s)).toBe(true);
  });

  it("setPosition shifts a smart object's transform.tx/ty by the move delta", () => {
    const doc = new Document(64, 64);
    const id = doc.addRasterLayer(
      { width: 8, height: 8, data: new Uint8ClampedArray(8 * 8 * 4) } as ImageData,
      "L",
      { x: 2, y: 3 },
    );
    doc.wrapAsSmartObject(
      id,
      { width: 8, height: 8, data: new Uint8ClampedArray(8 * 8 * 4) } as ImageData,
      2,
      3,
    );
    // Move by (+10, +5): both the AABB origin and the transform translation shift.
    doc.setPosition(id, 12, 8);
    const s = doc.getLayer(id)!;
    if (!isSmartLayer(s)) throw new Error("expected smart");
    expect(s.x).toBe(12);
    expect(s.y).toBe(8);
    expect(s.transform.tx).toBe(12); // 2 + 10
    expect(s.transform.ty).toBe(8); // 3 + 5
  });

  it("setSmartTransform updates the transform + footprint AABB; getSmartTransform copies it", () => {
    const doc = new Document(64, 64);
    const id = doc.addRasterLayer(
      { width: 8, height: 8, data: new Uint8ClampedArray(8 * 8 * 4) } as ImageData,
      "L",
      { x: 0, y: 0 },
    );
    doc.wrapAsSmartObject(
      id,
      { width: 8, height: 8, data: new Uint8ClampedArray(8 * 8 * 4) } as ImageData,
      0,
      0,
    );
    doc.setSmartTransform(
      id,
      { tx: 4, ty: 4, sx: 2, sy: 2, rot: 0 },
      { x: 4, y: 4, width: 16, height: 16 },
    );
    const t = doc.getSmartTransform(id)!;
    expect(t).toMatchObject({ tx: 4, ty: 4, sx: 2, sy: 2 });
    const s = doc.getLayer(id)!;
    expect(isSmartLayer(s) && s.width).toBe(16);
    // The returned transform is a copy (mutating it must not affect the layer).
    t.sx = 99;
    expect(doc.getSmartTransform(id)!.sx).toBe(2);
  });

  it("bakeSmartToRaster converts back to a plain raster at the resampled footprint", () => {
    const doc = new Document(64, 64);
    const id = doc.addRasterLayer(
      { width: 8, height: 8, data: new Uint8ClampedArray(8 * 8 * 4) } as ImageData,
      "L",
    );
    doc.wrapAsSmartObject(
      id,
      { width: 8, height: 8, data: new Uint8ClampedArray(8 * 8 * 4) } as ImageData,
      0,
      0,
    );
    const baked = { width: 16, height: 16, data: new Uint8ClampedArray(16 * 16 * 4) } as ImageData;
    doc.bakeSmartToRaster(id, baked, 1, 2);
    const r = doc.getLayer(id)!;
    expect(isRasterLayer(r)).toBe(true);
    expect(isRasterLayer(r) && r.width).toBe(16);
    expect(isRasterLayer(r) && r.x).toBe(1);
    expect(isRasterLayer(r) && r.y).toBe(2);
  });

  it("snapshot carries a smart summary (natural size + transform) only for smart layers", () => {
    const doc = new Document(64, 64);
    const id = doc.addRasterLayer(
      { width: 12, height: 6, data: new Uint8ClampedArray(12 * 6 * 4) } as ImageData,
      "L",
    );
    doc.wrapAsSmartObject(
      id,
      { width: 12, height: 6, data: new Uint8ClampedArray(12 * 6 * 4) } as ImageData,
      0,
      0,
    );
    const snap = doc.snapshot();
    const ls = snap.layers.find((l) => l.id === id)!;
    expect(ls.kind).toBe("smart");
    expect(ls.isGroup).toBe(false);
    expect(ls.smart).toBeDefined();
    expect(ls.smart!.naturalWidth).toBe(12);
    expect(ls.smart!.naturalHeight).toBe(6);
    expect(ls.smart!.transform.sx).toBe(1);
  });

  it("setTextPath / setTextWarp round-trip through the text snapshot; null clears them", () => {
    const doc = new Document(64, 64);
    const id = doc.addTextLayer(0, 0, { text: "abc" });
    doc.setTextPath(id, "path_42");
    doc.setTextWarp(id, { style: "arc", bend: 0.5, horizontal: 0.1, vertical: 0 });
    let ts = doc.snapshot().layers.find((l) => l.id === id)!.text!;
    expect(ts.pathId).toBe("path_42");
    expect(ts.warp).toMatchObject({ style: "arc", bend: 0.5 });
    // style 'none' (or null) clears the warp back to flat text.
    doc.setTextWarp(id, { style: "none", bend: 0 });
    doc.setTextPath(id, null);
    ts = doc.snapshot().layers.find((l) => l.id === id)!.text!;
    expect(ts.warp).toBeUndefined();
    expect(ts.pathId).toBe(null);
  });
});
