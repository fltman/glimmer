/**
 * Vector paths — the pen-tool data model and rasterizer.
 *
 * A document owns zero+ named `Path`s. A path is a list of subpaths; a subpath
 * is an ordered list of cubic-bezier anchors plus a `closed` flag. Each anchor
 * carries its position and two handle positions (all in DOCUMENT px):
 *   - in/out handles are absolute doc-space points (NOT deltas), matching how
 *     the UI overlay renders them (it just maps via getViewTransform()).
 *   - a CORNER anchor has its handles coincident with the anchor point.
 * The bezier between two consecutive anchors A -> B uses A.out and B.in as the
 * two control points (cubic). For a closed subpath the last -> first segment is
 * drawn the same way.
 *
 * This module is pure geometry + a Canvas2D rasterizer; it never touches GL. The
 * engine routes pen-tool pointer events into the live `PathStore` here and reads
 * back serializable descriptions for the UI overlay, and rasterizes closed
 * paths to an R8 buffer (for selection) or strokes/fills them on a 2D canvas
 * (for fill/strokePath, which the engine then folds into the active layer).
 */

/** A pen anchor. Position + both bezier handles, all absolute doc px. */
export interface Anchor {
  x: number;
  y: number;
  /** Incoming handle (control point for the segment ENTERING this anchor). */
  inX: number;
  inY: number;
  /** Outgoing handle (control point for the segment LEAVING this anchor). */
  outX: number;
  outY: number;
}

/** A connected run of anchors. `closed` joins last -> first. */
export interface SubPath {
  anchors: Anchor[];
  closed: boolean;
}

/** A named vector path (one or more subpaths). */
export interface Path {
  id: string;
  name: string;
  subpaths: SubPath[];
}

/** Serializable description handed to the UI overlay (already in doc px). */
export interface PathDescription {
  id: string;
  name: string;
  subpaths: SubPath[];
}

/** Fill rule for rasterizing a closed path region. */
export type FillRule = "nonzero" | "evenodd";

let pathSeq = 0;
function nextPathId(): string {
  pathSeq += 1;
  return `path_${pathSeq}_${Math.random().toString(36).slice(2, 8)}`;
}

/** Make a corner anchor (handles coincident with the point). */
export function cornerAnchor(x: number, y: number): Anchor {
  return { x, y, inX: x, inY: y, outX: x, outY: y };
}

/**
 * Make a smooth anchor: the out handle is placed at (x+dx, y+dy) and the in
 * handle is mirrored to (x-dx, y-dy). Used while click-dragging a new anchor.
 */
export function smoothAnchor(x: number, y: number, dx: number, dy: number): Anchor {
  return { x, y, inX: x - dx, inY: y - dy, outX: x + dx, outY: y + dy };
}

/**
 * The vector-path store: owns the committed named paths plus the single
 * "live" path being drawn by the pen tool. The engine drives this from pointer
 * events and exposes serializable reads to the UI.
 */
export class PathStore {
  private paths: Path[] = [];
  /** Index into `paths` of the currently-targeted path, or -1. */
  private activeIndex = -1;
  /**
   * The path currently being built with the pen tool, or null. When finished
   * (Esc/Enter) it is committed into `paths` and becomes the active path.
   */
  private live: Path | null = null;

  // ── reads ───────────────────────────────────────────────
  /** All committed paths (NOT including the in-progress live path). */
  getPaths(): PathDescription[] {
    return this.paths.map(describePath);
  }
  /** The in-progress live path, or null. */
  getActivePath(): PathDescription | null {
    if (this.live) return describePath(this.live);
    const p = this.paths[this.activeIndex];
    return p ? describePath(p) : null;
  }
  /** True while a live path is being built. */
  get isDrawing(): boolean {
    return this.live !== null;
  }
  /** Resolve a path by id, or the active/live path when id is omitted. */
  resolve(pathId?: string): Path | null {
    if (pathId) return this.paths.find((p) => p.id === pathId) ?? null;
    if (this.live) return this.live;
    return this.paths[this.activeIndex] ?? null;
  }

  // ── live path construction (pen tool) ───────────────────
  /**
   * Begin (or continue) the live path with a new anchor. Returns the new anchor
   * so the caller can drag its handle. If no live path exists, one is created.
   */
  beginAnchor(a: Anchor): Anchor {
    if (!this.live) {
      this.live = { id: nextPathId(), name: `Path ${this.paths.length + 1}`, subpaths: [{ anchors: [], closed: false }] };
    }
    const sp = this.liveSubpath();
    sp.anchors.push(a);
    return a;
  }

  /** The subpath currently being appended to (the last open subpath). */
  private liveSubpath(): SubPath {
    const live = this.live!;
    if (live.subpaths.length === 0) live.subpaths.push({ anchors: [], closed: false });
    return live.subpaths[live.subpaths.length - 1]!;
  }

  /** True if the live path has at least one anchor placed. */
  get liveHasAnchors(): boolean {
    return !!this.live && this.liveSubpath().anchors.length > 0;
  }

  /** The first anchor of the live subpath (for first-anchor close hit-tests). */
  liveFirstAnchor(): Anchor | null {
    if (!this.live) return null;
    const sp = this.liveSubpath();
    return sp.anchors[0] ?? null;
  }

  /** The most-recently placed anchor of the live subpath, or null. */
  liveLastAnchor(): Anchor | null {
    if (!this.live) return null;
    const sp = this.liveSubpath();
    return sp.anchors[sp.anchors.length - 1] ?? null;
  }

  /**
   * Set the out handle of the last live anchor (used while dragging) and mirror
   * it onto the in handle so the anchor stays smooth.
   */
  setLastAnchorOut(outX: number, outY: number, mirror = true): void {
    const a = this.liveLastAnchor();
    if (!a) return;
    a.outX = outX;
    a.outY = outY;
    if (mirror) {
      a.inX = 2 * a.x - outX;
      a.inY = 2 * a.y - outY;
    }
  }

  /** Close the live subpath (clicking its first anchor). */
  closeLive(): void {
    if (!this.live) return;
    this.liveSubpath().closed = true;
  }

  /**
   * Finish building the live path: commit it into `paths` (becoming active) and
   * clear the live state. Drops a degenerate path (< 2 anchors). Returns the
   * committed path id, or null if nothing was committed.
   */
  finishLive(): string | null {
    const live = this.live;
    this.live = null;
    if (!live) return null;
    // Drop empty/degenerate subpaths.
    live.subpaths = live.subpaths.filter((sp) => sp.anchors.length >= 2);
    if (live.subpaths.length === 0) return null;
    this.paths.push(live);
    this.activeIndex = this.paths.length - 1;
    return live.id;
  }

  /** Discard the live path without committing it. */
  clearLive(): void {
    this.live = null;
  }

  // ── committed-path editing ──────────────────────────────
  /** Delete a path by id (or the active path). Returns true if one was removed. */
  deletePath(pathId?: string): boolean {
    const idx = pathId
      ? this.paths.findIndex((p) => p.id === pathId)
      : this.activeIndex;
    if (idx < 0 || idx >= this.paths.length) return false;
    this.paths.splice(idx, 1);
    this.activeIndex = Math.min(this.activeIndex, this.paths.length - 1);
    return true;
  }

  /** Replace the whole path list (used by project load). */
  setPaths(paths: Path[]): void {
    this.paths = paths.map(clonePath);
    this.activeIndex = this.paths.length ? this.paths.length - 1 : -1;
    this.live = null;
  }

  /** Clear all paths + live state (used by project load / new document). */
  clearAll(): void {
    this.paths = [];
    this.activeIndex = -1;
    this.live = null;
  }
}

// ── geometry helpers ────────────────────────────────────────
function describePath(p: Path): PathDescription {
  return { id: p.id, name: p.name, subpaths: clonePath(p).subpaths };
}
function clonePath(p: Path): Path {
  return {
    id: p.id,
    name: p.name,
    subpaths: p.subpaths.map((sp) => ({
      closed: sp.closed,
      anchors: sp.anchors.map((a) => ({ ...a })),
    })),
  };
}

/**
 * Trace a path's subpaths onto a 2D context (already translated so doc px map
 * to context px via the supplied offset). Open subpaths are traced as a polyline
 * of beziers; closed subpaths also draw the wrap segment + closePath().
 */
export function tracePath(
  ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
  path: Path,
  ox: number,
  oy: number,
  onlyClosed: boolean,
): void {
  for (const sp of path.subpaths) {
    if (onlyClosed && !sp.closed) continue;
    const a = sp.anchors;
    if (a.length < 2) continue;
    ctx.moveTo(a[0]!.x - ox, a[0]!.y - oy);
    for (let i = 0; i < a.length - 1; i++) {
      const A = a[i]!;
      const B = a[i + 1]!;
      ctx.bezierCurveTo(A.outX - ox, A.outY - oy, B.inX - ox, B.inY - oy, B.x - ox, B.y - oy);
    }
    if (sp.closed) {
      const A = a[a.length - 1]!;
      const B = a[0]!;
      ctx.bezierCurveTo(A.outX - ox, A.outY - oy, B.inX - ox, B.inY - oy, B.x - ox, B.y - oy);
      ctx.closePath();
    }
  }
}

/** Loose document-space bounding box of a path (anchors + handles). null if empty. */
export function pathBounds(
  path: Path,
): { x: number; y: number; width: number; height: number } | null {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const sp of path.subpaths) {
    for (const a of sp.anchors) {
      for (const [x, y] of [
        [a.x, a.y],
        [a.inX, a.inY],
        [a.outX, a.outY],
      ] as const) {
        if (x < minX) minX = x;
        if (y < minY) minY = y;
        if (x > maxX) maxX = x;
        if (y > maxY) maxY = y;
      }
    }
  }
  if (!isFinite(minX)) return null;
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

/** True if the path has at least one closed subpath with >= 2 anchors. */
export function pathHasClosedRegion(path: Path): boolean {
  return path.subpaths.some((sp) => sp.closed && sp.anchors.length >= 2);
}
