import { describe, it, expect } from "vitest";
import {
  PathStore,
  cornerAnchor,
  smoothAnchor,
  pathBounds,
  pathHasClosedRegion,
  type Path,
} from "./Paths";

describe("PathStore pen-tool construction", () => {
  it("builds a corner-anchor path and commits it on finish", () => {
    const ps = new PathStore();
    ps.beginAnchor(cornerAnchor(10, 10));
    ps.beginAnchor(cornerAnchor(100, 10));
    ps.beginAnchor(cornerAnchor(100, 100));
    expect(ps.isDrawing).toBe(true);
    expect(ps.getPaths()).toHaveLength(0); // not committed yet
    const id = ps.finishLive();
    expect(id).toBeTruthy();
    expect(ps.isDrawing).toBe(false);
    const paths = ps.getPaths();
    expect(paths).toHaveLength(1);
    expect(paths[0]!.subpaths[0]!.anchors).toHaveLength(3);
    expect(paths[0]!.subpaths[0]!.closed).toBe(false);
  });

  it("mirrors the out handle onto the in handle for a smooth anchor", () => {
    const ps = new PathStore();
    ps.beginAnchor(cornerAnchor(50, 50));
    ps.setLastAnchorOut(80, 50, true); // drag right
    const live = ps.getActivePath()!;
    const a = live.subpaths[0]!.anchors[0]!;
    expect(a.outX).toBe(80);
    expect(a.outY).toBe(50);
    // Mirror: in = 2*pos - out
    expect(a.inX).toBe(20);
    expect(a.inY).toBe(50);
  });

  it("closes a subpath and reports a closed region", () => {
    const ps = new PathStore();
    ps.beginAnchor(cornerAnchor(0, 0));
    ps.beginAnchor(cornerAnchor(100, 0));
    ps.beginAnchor(cornerAnchor(100, 100));
    ps.closeLive();
    const id = ps.finishLive();
    const path = ps.resolve(id!)!;
    expect(path.subpaths[0]!.closed).toBe(true);
    expect(pathHasClosedRegion(path)).toBe(true);
  });

  it("drops degenerate (<2-anchor) subpaths on finish", () => {
    const ps = new PathStore();
    ps.beginAnchor(cornerAnchor(5, 5)); // single anchor
    const id = ps.finishLive();
    expect(id).toBeNull();
    expect(ps.getPaths()).toHaveLength(0);
  });

  it("round-trips through setPaths (project load)", () => {
    const ps = new PathStore();
    const path: Path = {
      id: "p1",
      name: "Outline",
      subpaths: [
        {
          closed: true,
          anchors: [
            smoothAnchor(10, 10, 5, 0),
            cornerAnchor(90, 10),
            cornerAnchor(90, 90),
          ],
        },
      ],
    };
    ps.setPaths([path]);
    const out = ps.getPaths();
    expect(out).toHaveLength(1);
    expect(out[0]!.id).toBe("p1");
    expect(out[0]!.subpaths[0]!.anchors).toHaveLength(3);
  });
});

describe("pathBounds", () => {
  it("includes handles in the bounding box", () => {
    const path: Path = {
      id: "p",
      name: "p",
      subpaths: [{ closed: false, anchors: [smoothAnchor(50, 50, 40, 0), cornerAnchor(60, 60)] }],
    };
    const b = pathBounds(path)!;
    // out handle at 90, in handle at 10 -> x spans 10..90
    expect(b.x).toBe(10);
    expect(b.x + b.width).toBe(90);
  });
});
