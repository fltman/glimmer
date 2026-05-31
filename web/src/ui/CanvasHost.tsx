/**
 * Mounts a single <canvas> exactly once and hands it to the singleton engine.
 * The canvas is NEVER remounted — a remount would destroy the GL context and
 * the document with it. React only owns the wrapping <div>'s layout.
 *
 * An SVG overlay (synced to the engine's view transform via rAF) draws the
 * in-progress marquee/lasso/gradient outline crisply under zoom, plus the
 * free-transform box (rotated outline + 8 scale handles + rotate affordance +
 * readout), the crop rect (dimmed outside + rule-of-thirds + edge/corner
 * handles), and the live shape (rect/ellipse/line) preview. The committed
 * selection contour's marching ants are drawn in GL by the engine, which also
 * owns ALL pointer math — this overlay is purely visual (pointer-events:none),
 * so drags fall through to the canvas. The cursor reflects the active tool.
 */
import { useEffect, useRef, useState } from "react";
import { engine } from "../state/useEngine";
import { useToolState, type ToolId } from "../state/tools";
import type { SubPath } from "../engine/Paths";

const CURSORS: Record<ToolId, string> = {
  move: "move",
  brush: "crosshair",
  eraser: "crosshair",
  "marquee-rect": "crosshair",
  "marquee-ellipse": "crosshair",
  lasso: "crosshair",
  "magic-wand": "crosshair",
  hand: "grab",
  eyedropper: "crosshair",
  bucket: "crosshair",
  gradient: "crosshair",
  pen: "crosshair",
  transform: "default",
  crop: "crosshair",
  text: "text",
  shape: "crosshair",
  clone: "crosshair",
  heal: "crosshair",
  dodge: "crosshair",
  burn: "crosshair",
  smudge: "crosshair",
  "blur-brush": "crosshair",
  "sharpen-brush": "crosshair",
};

/** Accent blue used across the chrome (matches the Tailwind `accent` token). */
const ACCENT = "#5b8cff";

/** Ruler strip thickness in CSS px (top + left). */
const RULER_SIZE = 18;
/** Guide line color (Photoshop cyan). */
const GUIDE_COLOR = "#36c5f0";

/**
 * Live selection / transform / crop / shape outlines plus the persistent
 * rulers / guides / grid / pen-path preview, all in CSS px over the canvas.
 *
 * The SVG itself stays `pointer-events:none` so drags fall through to the
 * canvas (the engine owns all pointer math for the painting/selection tools).
 * Two interactive ruler strips (`pointer-events:auto`) sit on the top + left
 * edges; existing guides expose thin hit-lines so they can be re-dragged.
 */
function CanvasOverlay() {
  const [, force] = useState(0);
  useEffect(() => {
    let raf = 0;
    const tick = () => {
      force((n) => (n + 1) & 0xffff);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, []);

  const view = engine.getViewTransform();
  const toScreen = (x: number, y: number): [number, number] => [
    x * view.scale + view.tx,
    y * view.scale + view.ty,
  ];

  const marquee = engine.getLiveMarquee();
  const lasso = engine.getLiveLasso();
  const gradient = engine.getLiveGradient();
  const transform = engine.getTransformState();
  const crop = engine.getCropState();
  const shape = engine.getLiveShape();

  const rulersVisible = engine.getRulersVisible();
  const grid = engine.getGrid();
  const guides = engine.getGuides();
  const liveGuide = engine.getLiveGuide();
  const activePath = engine.getActivePath();
  const committedPaths = engine.getPaths();
  const doc = engine.getSnapshot();

  return (
    <>
      {/* Non-interactive visual layer (everything but the ruler strips). */}
      <svg className="pointer-events-none absolute inset-0 h-full w-full overflow-visible">
        {grid.visible && (
          <GridOverlay grid={grid} docW={doc.width} docH={doc.height} toScreen={toScreen} />
        )}
        {guides.map((g) => (
          <GuideLine key={g.id} guide={g} toScreen={toScreen} />
        ))}
        {liveGuide && <GuideLine guide={liveGuide} toScreen={toScreen} live />}
        {committedPaths.map((p) => (
          <PathPreview key={p.id} subpaths={p.subpaths} toScreen={toScreen} active={false} />
        ))}
        {activePath && (
          <PathPreview subpaths={activePath.subpaths} toScreen={toScreen} active />
        )}
        {marquee && <MarqueePreview marquee={marquee} toScreen={toScreen} />}
        {lasso && lasso.length >= 4 && <LassoPreview lasso={lasso} toScreen={toScreen} />}
        {gradient && <GradientPreview gradient={gradient} toScreen={toScreen} />}
        {crop && <CropOverlay crop={crop} />}
        {transform && <TransformOverlay st={transform} />}
        {shape && <ShapePreview shape={shape} toScreen={toScreen} />}
      </svg>

      {/* Interactive layer: ruler strips (drag = new guide) + guide hit-lines. */}
      {rulersVisible && (
        <Rulers docW={doc.width} docH={doc.height} view={view} toScreen={toScreen} />
      )}
      <GuideHandles guides={guides} toScreen={toScreen} rulersVisible={rulersVisible} />
    </>
  );
}

type ToScreen = (x: number, y: number) => [number, number];

type ViewTransform = ReturnType<typeof engine.getViewTransform>;
type GuideShape = ReturnType<typeof engine.getGuides>[number];
type GridShape = ReturnType<typeof engine.getGrid>;

/** In-progress marquee rectangle / ellipse (doc px → screen). */
function MarqueePreview({
  marquee,
  toScreen,
}: {
  marquee: NonNullable<ReturnType<typeof engine.getLiveMarquee>>;
  toScreen: ToScreen;
}) {
  const [sx0, sy0] = toScreen(marquee.x0, marquee.y0);
  const [sx1, sy1] = toScreen(marquee.x1, marquee.y1);
  const x = Math.min(sx0, sx1);
  const y = Math.min(sy0, sy1);
  const w = Math.abs(sx1 - sx0);
  const h = Math.abs(sy1 - sy0);
  const common = {
    fill: "none",
    stroke: "white",
    strokeWidth: 1,
    strokeDasharray: "5 4",
  } as const;
  return marquee.shape === "ellipse" ? (
    <ellipse cx={x + w / 2} cy={y + h / 2} rx={w / 2} ry={h / 2} {...common} />
  ) : (
    <rect x={x} y={y} width={w} height={h} {...common} />
  );
}

/** In-progress lasso polygon (flat [x0,y0,x1,y1,…] doc px). */
function LassoPreview({ lasso, toScreen }: { lasso: number[]; toScreen: ToScreen }) {
  const pts: string[] = [];
  for (let i = 0; i < lasso.length; i += 2) {
    const [sx, sy] = toScreen(lasso[i]!, lasso[i + 1]!);
    pts.push(`${sx},${sy}`);
  }
  return (
    <polyline
      points={pts.join(" ")}
      fill="rgba(91,140,255,0.08)"
      stroke="white"
      strokeWidth={1}
      strokeDasharray="5 4"
    />
  );
}

/** In-progress gradient drag line with from/to endpoint dots. */
function GradientPreview({
  gradient,
  toScreen,
}: {
  gradient: NonNullable<ReturnType<typeof engine.getLiveGradient>>;
  toScreen: ToScreen;
}) {
  const [x0, y0] = toScreen(gradient.from.x, gradient.from.y);
  const [x1, y1] = toScreen(gradient.to.x, gradient.to.y);
  return (
    <g>
      <line x1={x0} y1={y0} x2={x1} y2={y1} stroke="black" strokeWidth={3} strokeOpacity={0.5} />
      <line x1={x0} y1={y0} x2={x1} y2={y1} stroke="white" strokeWidth={1} />
      <circle cx={x0} cy={y0} r={3.5} fill="white" stroke="black" strokeWidth={1} />
      <circle cx={x1} cy={y1} r={3.5} fill="white" stroke="black" strokeWidth={1} />
    </g>
  );
}

/**
 * Free-transform chrome: rotated outline (4 corners NW,NE,SE,SW), 8 scale
 * handles, a rotate affordance stem above the top edge, and a rotation readout.
 * All coordinates from the engine are already in screen (CSS) px.
 */
function TransformOverlay({
  st,
}: {
  st: NonNullable<ReturnType<typeof engine.getTransformState>>;
}) {
  const [nw, ne, se, sw] = st.corners;
  if (!nw || !ne || !se || !sw) return null;
  const outline = `${nw.x},${nw.y} ${ne.x},${ne.y} ${se.x},${se.y} ${sw.x},${sw.y}`;

  // Rotate affordance: a short stem normal to the top edge (NW→NE) at its
  // midpoint, pointing away from the box centre.
  const topMid = { x: (nw.x + ne.x) / 2, y: (nw.y + ne.y) / 2 };
  const center = { x: (nw.x + se.x) / 2, y: (nw.y + se.y) / 2 };
  let nx = topMid.x - center.x;
  let ny = topMid.y - center.y;
  const nlen = Math.hypot(nx, ny) || 1;
  nx /= nlen;
  ny /= nlen;
  const STEM = 20;
  const knob = { x: topMid.x + nx * STEM, y: topMid.y + ny * STEM };

  // Readout sits just outside the top-left corner.
  const readout = `${Math.round(st.rotationDeg)}°`;

  return (
    <g>
      {/* Rotated bounding outline (drawn twice for contrast over any content). */}
      <polygon points={outline} fill="none" stroke="black" strokeWidth={2} strokeOpacity={0.35} />
      <polygon points={outline} fill="none" stroke={ACCENT} strokeWidth={1} />

      {/* Rotate affordance stem + knob above the top edge. */}
      <line x1={topMid.x} y1={topMid.y} x2={knob.x} y2={knob.y} stroke={ACCENT} strokeWidth={1} />
      <circle cx={knob.x} cy={knob.y} r={4} fill="#0b0c0d" stroke={ACCENT} strokeWidth={1.25} />

      {/* 8 scale handles (small filled squares). */}
      {st.handles.map((h) => (
        <rect
          key={h.id}
          x={h.x - 4}
          y={h.y - 4}
          width={8}
          height={8}
          rx={1}
          fill="white"
          stroke={ACCENT}
          strokeWidth={1}
        />
      ))}

      {/* Rotation readout pill. */}
      <g transform={`translate(${nw.x + 6}, ${nw.y - 22})`}>
        <rect x={0} y={0} width={readout.length * 7 + 14} height={16} rx={3} fill="#0b0c0d" fillOpacity={0.85} stroke="#2a2d31" />
        <text x={7} y={12} fontSize={11} fontFamily="ui-monospace, monospace" fill="#e5e7eb">
          {readout}
        </text>
      </g>
    </g>
  );
}

/**
 * Crop chrome: a darkened mask over everything OUTSIDE the crop rect (four
 * rects so the inside stays clear), the crop outline, rule-of-thirds grid, and
 * edge + corner handles. The rect from the engine is already in screen px.
 */
function CropOverlay({ crop }: { crop: NonNullable<ReturnType<typeof engine.getCropState>> }) {
  const { x, y, width: w, height: h } = crop.rect;
  // A very large frame so the darkened mask covers the whole viewport.
  const F = 100000;
  const dim = "rgba(0,0,0,0.55)";

  // Rule-of-thirds positions.
  const v1 = x + w / 3;
  const v2 = x + (2 * w) / 3;
  const h1 = y + h / 3;
  const h2 = y + (2 * h) / 3;

  // Handle positions: 4 corners + 4 edge midpoints.
  const handles = [
    { x, y },
    { x: x + w / 2, y },
    { x: x + w, y },
    { x: x + w, y: y + h / 2 },
    { x: x + w, y: y + h },
    { x: x + w / 2, y: y + h },
    { x, y: y + h },
    { x, y: y + h / 2 },
  ];

  return (
    <g>
      {/* Darkened outside (top / bottom / left / right bands around the rect). */}
      <rect x={-F} y={-F} width={2 * F} height={F + y} fill={dim} />
      <rect x={-F} y={y + h} width={2 * F} height={F} fill={dim} />
      <rect x={-F} y={y} width={F + x} height={h} fill={dim} />
      <rect x={x + w} y={y} width={F} height={h} fill={dim} />

      {/* Rule-of-thirds grid. */}
      <g stroke="white" strokeOpacity={0.4} strokeWidth={1}>
        <line x1={v1} y1={y} x2={v1} y2={y + h} />
        <line x1={v2} y1={y} x2={v2} y2={y + h} />
        <line x1={x} y1={h1} x2={x + w} y2={h1} />
        <line x1={x} y1={h2} x2={x + w} y2={h2} />
      </g>

      {/* Crop outline. */}
      <rect x={x} y={y} width={w} height={h} fill="none" stroke="white" strokeWidth={1} />

      {/* Corner + edge handles. */}
      {handles.map((p, i) => (
        <rect
          key={i}
          x={p.x - 4}
          y={p.y - 4}
          width={8}
          height={8}
          fill="white"
          stroke={ACCENT}
          strokeWidth={1}
        />
      ))}
    </g>
  );
}

/** In-progress shape preview (rect / ellipse / line), doc px → screen. */
function ShapePreview({
  shape,
  toScreen,
}: {
  shape: NonNullable<ReturnType<typeof engine.getLiveShape>>;
  toScreen: ToScreen;
}) {
  const [x0, y0] = toScreen(shape.from.x, shape.from.y);
  const [x1, y1] = toScreen(shape.to.x, shape.to.y);
  const common = {
    fill: "none",
    stroke: "white",
    strokeWidth: 1,
    strokeDasharray: "4 3",
  } as const;
  if (shape.kind === "line") {
    return (
      <g>
        <line x1={x0} y1={y0} x2={x1} y2={y1} stroke="black" strokeWidth={3} strokeOpacity={0.4} />
        <line x1={x0} y1={y0} x2={x1} y2={y1} stroke="white" strokeWidth={1} />
      </g>
    );
  }
  const x = Math.min(x0, x1);
  const y = Math.min(y0, y1);
  const w = Math.abs(x1 - x0);
  const h = Math.abs(y1 - y0);
  return shape.kind === "ellipse" ? (
    <ellipse cx={x + w / 2} cy={y + h / 2} rx={w / 2} ry={h / 2} {...common} />
  ) : (
    <rect x={x} y={y} width={w} height={h} {...common} />
  );
}

// ════════════════════════════════════════════════════════════
//  GRID
// ════════════════════════════════════════════════════════════
/**
 * Subtle grid overlay across the document bounds, mapped through the view
 * transform. Major lines at `grid.size`, fainter minor lines at the
 * subdivisions. Lines beyond ~0.5 px on screen are skipped so dense grids at
 * tiny zoom don't smear into a solid block.
 */
function GridOverlay({
  grid,
  docW,
  docH,
  toScreen,
}: {
  grid: GridShape;
  docW: number;
  docH: number;
  toScreen: ToScreen;
}) {
  const minor = Math.max(1, grid.size / Math.max(1, grid.subdivisions));
  const [, sy0] = toScreen(0, 0);
  const [, sy1] = toScreen(0, 1); // 1 doc px in screen px (for spacing test)
  const pxPerDoc = Math.abs(sy1 - sy0) || 1;

  const lines: { x1: number; y1: number; x2: number; y2: number; major: boolean }[] = [];

  // Vertical lines (constant X). Minor first so majors paint on top.
  if (minor * pxPerDoc >= 4) {
    for (let x = 0; x <= docW + 1e-3; x += minor) {
      const major = Math.abs(x / grid.size - Math.round(x / grid.size)) < 1e-3;
      if (major) continue; // drawn in the major pass
      const [sx, ya] = toScreen(x, 0);
      const [, yb] = toScreen(x, docH);
      lines.push({ x1: sx, y1: ya, x2: sx, y2: yb, major: false });
    }
    for (let y = 0; y <= docH + 1e-3; y += minor) {
      const major = Math.abs(y / grid.size - Math.round(y / grid.size)) < 1e-3;
      if (major) continue;
      const [xa, sy] = toScreen(0, y);
      const [xb] = toScreen(docW, y);
      lines.push({ x1: xa, y1: sy, x2: xb, y2: sy, major: false });
    }
  }
  // Major lines.
  if (grid.size * pxPerDoc >= 4) {
    for (let x = 0; x <= docW + 1e-3; x += grid.size) {
      const [sx, ya] = toScreen(x, 0);
      const [, yb] = toScreen(x, docH);
      lines.push({ x1: sx, y1: ya, x2: sx, y2: yb, major: true });
    }
    for (let y = 0; y <= docH + 1e-3; y += grid.size) {
      const [xa, sy] = toScreen(0, y);
      const [xb] = toScreen(docW, y);
      lines.push({ x1: xa, y1: sy, x2: xb, y2: sy, major: true });
    }
  }

  return (
    <g>
      {lines.map((l, i) => (
        <line
          key={i}
          x1={l.x1}
          y1={l.y1}
          x2={l.x2}
          y2={l.y2}
          stroke="#5b8cff"
          strokeWidth={l.major ? 1 : 0.5}
          strokeOpacity={l.major ? 0.32 : 0.16}
        />
      ))}
    </g>
  );
}

// ════════════════════════════════════════════════════════════
//  GUIDES
// ════════════════════════════════════════════════════════════
/** A single guide line across the whole viewport (cyan; live = dashed). */
function GuideLine({
  guide,
  toScreen,
  live = false,
}: {
  guide: GuideShape;
  toScreen: ToScreen;
  live?: boolean;
}) {
  const F = 100000;
  const common = {
    stroke: GUIDE_COLOR,
    strokeWidth: 1,
    strokeOpacity: live ? 0.9 : 0.85,
    strokeDasharray: live ? "4 3" : undefined,
  } as const;
  if (guide.axis === "h") {
    const [, sy] = toScreen(0, guide.pos);
    return <line x1={-F} y1={sy} x2={F} y2={sy} {...common} />;
  }
  const [sx] = toScreen(guide.pos, 0);
  return <line x1={sx} y1={-F} x2={sx} y2={F} {...common} />;
}

/**
 * Interactive hit-lines over the committed guides: pointer-down on a guide
 * starts a move-drag (via moveGuide). Dragging it onto the ruler strip or off
 * the document removes it (removeGuide). These thin transparent lines sit above
 * the canvas with `pointer-events:auto`; the visible cyan lines are drawn in the
 * non-interactive SVG so they always show under the live preview.
 */
function GuideHandles({
  guides,
  toScreen,
  rulersVisible,
}: {
  guides: GuideShape[];
  toScreen: ToScreen;
  rulersVisible: boolean;
}) {
  if (guides.length === 0) return null;
  const rulerEdge = rulersVisible ? RULER_SIZE : 0;

  const onDown = (g: GuideShape) => (e: React.PointerEvent<SVGLineElement>) => {
    e.preventDefault();
    e.stopPropagation();
    (e.target as Element).setPointerCapture(e.pointerId);
    const host = e.currentTarget.ownerSVGElement?.parentElement;

    const localFromEvent = (ev: PointerEvent): { x: number; y: number } => {
      const rect = host?.getBoundingClientRect();
      return {
        x: ev.clientX - (rect?.left ?? 0),
        y: ev.clientY - (rect?.top ?? 0),
      };
    };

    const view = engine.getViewTransform();
    const docW = engine.getSnapshot().width;
    const docH = engine.getSnapshot().height;

    const onMove = (ev: PointerEvent) => {
      const local = localFromEvent(ev);
      // Snap independently to the engine's snap candidates.
      const docPt = engine.snapPointDoc(
        {
          x: (local.x - view.tx) / view.scale,
          y: (local.y - view.ty) / view.scale,
        },
        8,
      );
      engine.moveGuide(g.id, g.axis === "h" ? docPt.y : docPt.x);
    };

    const onUp = (ev: PointerEvent) => {
      const local = localFromEvent(ev);
      // Dropped onto a ruler strip OR outside the doc bounds → remove.
      const onRuler =
        rulersVisible && (local.x < rulerEdge || local.y < rulerEdge);
      const pos =
        g.axis === "h"
          ? (local.y - view.ty) / view.scale
          : (local.x - view.tx) / view.scale;
      const outside = g.axis === "h" ? pos < 0 || pos > docH : pos < 0 || pos > docW;
      if (onRuler || outside) engine.removeGuide(g.id);
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };

    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  };

  const F = 100000;
  return (
    <svg className="pointer-events-none absolute inset-0 h-full w-full overflow-visible">
      {guides.map((g) => {
        if (g.axis === "h") {
          const [, sy] = toScreen(0, g.pos);
          return (
            <line
              key={g.id}
              x1={-F}
              y1={sy}
              x2={F}
              y2={sy}
              stroke="transparent"
              strokeWidth={9}
              className="pointer-events-auto cursor-ns-resize"
              onPointerDown={onDown(g)}
            />
          );
        }
        const [sx] = toScreen(g.pos, 0);
        return (
          <line
            key={g.id}
            x1={sx}
            y1={-F}
            x2={sx}
            y2={F}
            stroke="transparent"
            strokeWidth={9}
            className="pointer-events-auto cursor-ew-resize"
            onPointerDown={onDown(g)}
          />
        );
      })}
    </svg>
  );
}

// ════════════════════════════════════════════════════════════
//  RULERS
// ════════════════════════════════════════════════════════════
/**
 * Nice round tick spacing in DOC px so labels stay ~60–120 screen px apart
 * regardless of zoom. Walks the 1/2/5 × 10ⁿ ladder.
 */
function chooseTickStep(pxPerDoc: number): number {
  const targetScreen = 80; // desired px between major ticks
  const rawDoc = targetScreen / Math.max(1e-4, pxPerDoc);
  const pow = Math.pow(10, Math.floor(Math.log10(rawDoc)));
  const norm = rawDoc / pow;
  const mult = norm >= 5 ? 5 : norm >= 2 ? 2 : 1;
  return mult * pow;
}

/**
 * Top (horizontal) + left (vertical) ruler strips. Ticks + labels are derived
 * from the view transform with 0 at the doc origin. Each strip captures pointer
 * drags to pull out a new guide (beginGuideDrag / updateGuideDrag / endGuideDrag),
 * with a live cyan preview line rendered by the non-interactive SVG.
 */
function Rulers({
  docW,
  docH,
  view,
  toScreen,
}: {
  docW: number;
  docH: number;
  view: ViewTransform;
  toScreen: ToScreen;
}) {
  const pxPerDoc = view.scale;
  const step = chooseTickStep(pxPerDoc);

  // Build the visible doc range for each axis from the view transform. We tick
  // a generous band (0 .. doc size, plus a margin) so labels appear across the
  // whole strip even when the doc is scrolled.
  const margin = 4000;
  const hTicks: { doc: number; screen: number }[] = [];
  for (let d = 0; d <= docW + margin; d += step) {
    const [sx] = toScreen(d, 0);
    hTicks.push({ doc: d, screen: sx });
  }
  const vTicks: { doc: number; screen: number }[] = [];
  for (let d = 0; d <= docH + margin; d += step) {
    const [, sy] = toScreen(0, d);
    vTicks.push({ doc: d, screen: sy });
  }

  // A ruler drag pulls a guide out perpendicular to the strip.
  const startDrag =
    (axis: "h" | "v") => (e: React.PointerEvent<HTMLDivElement>) => {
      e.preventDefault();
      const host = e.currentTarget.parentElement; // the relative container
      (e.target as Element).setPointerCapture(e.pointerId);
      const local = (ev: PointerEvent): { x: number; y: number } => {
        const rect = host?.getBoundingClientRect();
        return { x: ev.clientX - (rect?.left ?? 0), y: ev.clientY - (rect?.top ?? 0) };
      };
      const p0 = local(e.nativeEvent);
      engine.beginGuideDrag(axis, p0.x, p0.y);
      const onMove = (ev: PointerEvent) => {
        const p = local(ev);
        engine.updateGuideDrag(p.x, p.y);
      };
      const onUp = () => {
        engine.endGuideDrag();
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", onUp);
      };
      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onUp);
    };

  const stripBg = "#15171a";
  const tickColor = "#5a626b";
  const labelColor = "#9aa1aa";

  return (
    <>
      {/* Top horizontal ruler. Dragging down pulls out an 'h' guide. */}
      <div
        className="pointer-events-auto absolute left-0 top-0 cursor-ns-resize select-none"
        style={{ height: RULER_SIZE, right: 0, background: stripBg, borderBottom: "1px solid #2a2d31" }}
        onPointerDown={startDrag("h")}
      >
        <svg className="absolute inset-0 h-full w-full overflow-hidden">
          {hTicks.map((t) => (
            <g key={t.doc}>
              <line x1={t.screen} y1={RULER_SIZE - 6} x2={t.screen} y2={RULER_SIZE} stroke={tickColor} strokeWidth={1} />
              <text x={t.screen + 3} y={11} fontSize={9} fontFamily="ui-monospace, monospace" fill={labelColor}>
                {Math.round(t.doc)}
              </text>
            </g>
          ))}
        </svg>
      </div>

      {/* Left vertical ruler. Dragging right pulls out a 'v' guide. */}
      <div
        className="pointer-events-auto absolute left-0 cursor-ew-resize select-none"
        style={{ width: RULER_SIZE, top: RULER_SIZE, bottom: 0, background: stripBg, borderRight: "1px solid #2a2d31" }}
        onPointerDown={startDrag("v")}
      >
        <svg className="absolute inset-0 h-full w-full overflow-hidden">
          {vTicks.map((t) => (
            <g key={t.doc}>
              {/* Offset by RULER_SIZE because this strip starts below the top ruler. */}
              <line
                x1={RULER_SIZE - 6}
                y1={t.screen - RULER_SIZE}
                x2={RULER_SIZE}
                y2={t.screen - RULER_SIZE}
                stroke={tickColor}
                strokeWidth={1}
              />
              <text
                x={2}
                y={t.screen - RULER_SIZE + 10}
                fontSize={9}
                fontFamily="ui-monospace, monospace"
                fill={labelColor}
                transform={`rotate(90, 2, ${t.screen - RULER_SIZE + 10})`}
              >
                {Math.round(t.doc)}
              </text>
            </g>
          ))}
        </svg>
      </div>

      {/* Corner square where the two strips meet. */}
      <div
        className="pointer-events-auto absolute left-0 top-0"
        style={{ width: RULER_SIZE, height: RULER_SIZE, background: "#1b1e22", borderRight: "1px solid #2a2d31", borderBottom: "1px solid #2a2d31" }}
      />
    </>
  );
}

// ════════════════════════════════════════════════════════════
//  PEN PATH PREVIEW
// ════════════════════════════════════════════════════════════
/**
 * Build an SVG path `d` string for a list of subpaths, mapping every anchor +
 * bezier handle through the view transform. Segment A→B uses A.out and B.in as
 * the cubic control points (corner anchors keep handles coincident with the
 * point, degrading the cubic to a straight line). Closed subpaths add the
 * last→first segment + Z.
 */
function subpathsToD(subpaths: SubPath[], toScreen: ToScreen): string {
  const parts: string[] = [];
  for (const sp of subpaths) {
    const a = sp.anchors;
    if (a.length === 0) continue;
    const [mx, my] = toScreen(a[0]!.x, a[0]!.y);
    parts.push(`M ${mx} ${my}`);
    for (let i = 1; i < a.length; i++) {
      const prev = a[i - 1]!;
      const cur = a[i]!;
      const [c1x, c1y] = toScreen(prev.outX, prev.outY);
      const [c2x, c2y] = toScreen(cur.inX, cur.inY);
      const [ex, ey] = toScreen(cur.x, cur.y);
      parts.push(`C ${c1x} ${c1y} ${c2x} ${c2y} ${ex} ${ey}`);
    }
    if (sp.closed && a.length >= 2) {
      const last = a[a.length - 1]!;
      const first = a[0]!;
      const [c1x, c1y] = toScreen(last.outX, last.outY);
      const [c2x, c2y] = toScreen(first.inX, first.inY);
      const [ex, ey] = toScreen(first.x, first.y);
      parts.push(`C ${c1x} ${c1y} ${c2x} ${c2y} ${ex} ${ey}`);
      parts.push("Z");
    }
  }
  return parts.join(" ");
}

/**
 * Vector-path preview: the bezier curve plus anchor squares. For the active
 * (live or selected) path it also draws each anchor's in/out handle lines + dots
 * so the user can see the bezier tangents while drawing with the pen tool.
 */
function PathPreview({
  subpaths,
  toScreen,
  active,
}: {
  subpaths: SubPath[];
  toScreen: ToScreen;
  active: boolean;
}) {
  const d = subpathsToD(subpaths, toScreen);
  if (!d) return null;

  return (
    <g>
      {/* Curve (dark halo + accent line for contrast over any content). */}
      <path d={d} fill="none" stroke="black" strokeWidth={2} strokeOpacity={0.4} />
      <path d={d} fill="none" stroke={ACCENT} strokeWidth={1} />

      {subpaths.map((sp, si) =>
        sp.anchors.map((an, ai) => {
          const [px, py] = toScreen(an.x, an.y);
          const [ix, iy] = toScreen(an.inX, an.inY);
          const [ox, oy] = toScreen(an.outX, an.outY);
          const hasIn = Math.hypot(ix - px, iy - py) > 0.5;
          const hasOut = Math.hypot(ox - px, oy - py) > 0.5;
          return (
            <g key={`${si}-${ai}`}>
              {/* Handle lines + dots (only for the active path, only if non-zero). */}
              {active && hasIn && (
                <>
                  <line x1={px} y1={py} x2={ix} y2={iy} stroke={ACCENT} strokeWidth={0.75} strokeOpacity={0.8} />
                  <circle cx={ix} cy={iy} r={2.5} fill={ACCENT} stroke="white" strokeWidth={0.5} />
                </>
              )}
              {active && hasOut && (
                <>
                  <line x1={px} y1={py} x2={ox} y2={oy} stroke={ACCENT} strokeWidth={0.75} strokeOpacity={0.8} />
                  <circle cx={ox} cy={oy} r={2.5} fill={ACCENT} stroke="white" strokeWidth={0.5} />
                </>
              )}
              {/* Anchor point (small square). */}
              <rect
                x={px - 3}
                y={py - 3}
                width={6}
                height={6}
                fill="white"
                stroke={ACCENT}
                strokeWidth={1}
              />
            </g>
          );
        }),
      )}
    </g>
  );
}

export function CanvasHost() {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const { active } = useToolState();

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    engine.mount(canvas);
    return () => engine.unmount();
  }, []);

  return (
    <div className="relative h-full w-full overflow-hidden bg-[#0b0c0d]">
      <canvas
        ref={canvasRef}
        className="block h-full w-full touch-none select-none"
        style={{ cursor: CURSORS[active] }}
      />
      <CanvasOverlay />
    </div>
  );
}
