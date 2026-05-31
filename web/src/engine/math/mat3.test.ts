import { describe, it, expect } from "vitest";
import * as m3 from "./mat3";

describe("mat3", () => {
  it("identity is neutral under multiply", () => {
    const a = m3.translate(m3.identity(), 3, 5);
    const out = m3.multiply(m3.identity(), a);
    expect([...out]).toEqual([...a]);
  });

  it("translate then transformPoint", () => {
    const m = m3.translation(10, -4);
    const p = m3.transformPoint(m, 2, 2);
    expect(p).toEqual({ x: 12, y: -2 });
  });

  it("scale then transformPoint", () => {
    const m = m3.scaling(2, 3);
    const p = m3.transformPoint(m, 4, 4);
    expect(p).toEqual({ x: 8, y: 12 });
  });

  it("invert undoes a transform", () => {
    const m = m3.multiply(m3.translation(7, -3), m3.scaling(2, 4));
    const inv = m3.invert(m);
    const fwd = m3.transformPoint(m, 5, 6);
    const round = m3.transformPoint(inv, fwd.x, fwd.y);
    expect(round.x).toBeCloseTo(5, 6);
    expect(round.y).toBeCloseTo(6, 6);
  });

  it("composition order: multiply(A,B) applies B first", () => {
    const t = m3.translation(10, 0);
    const s = m3.scaling(2, 2);
    // Apply scale first, then translate.
    const m = m3.multiply(t, s);
    const p = m3.transformPoint(m, 1, 1);
    expect(p).toEqual({ x: 12, y: 2 });
  });

  it("rotation by 90° maps (1,0)->(0,1) under +y-down convention", () => {
    const m = m3.rotation(Math.PI / 2);
    const p = m3.transformPoint(m, 1, 0);
    expect(p.x).toBeCloseTo(0, 6);
    expect(p.y).toBeCloseTo(1, 6);
  });

  it("rotate about center then back is identity-ish", () => {
    const cx = 5;
    const cy = 7;
    // Rotate a point about (cx,cy) by 45°, then by -45°.
    const fwd = m3.multiply(
      m3.translation(cx, cy),
      m3.multiply(m3.rotation(Math.PI / 4), m3.translation(-cx, -cy)),
    );
    const back = m3.multiply(
      m3.translation(cx, cy),
      m3.multiply(m3.rotation(-Math.PI / 4), m3.translation(-cx, -cy)),
    );
    const round = m3.transformPoint(m3.multiply(back, fwd), 9, 2);
    expect(round.x).toBeCloseTo(9, 6);
    expect(round.y).toBeCloseTo(2, 6);
  });
});
