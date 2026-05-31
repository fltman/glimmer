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

/** Live selection / transform / crop / shape outlines, in CSS px over the canvas. */
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

  // Nothing to draw → render nothing (keeps the SVG out of the layer tree).
  if (!marquee && !lasso && !gradient && !transform && !crop && !shape) {
    return null;
  }

  return (
    <svg className="pointer-events-none absolute inset-0 h-full w-full overflow-visible">
      {marquee && <MarqueePreview marquee={marquee} toScreen={toScreen} />}
      {lasso && lasso.length >= 4 && <LassoPreview lasso={lasso} toScreen={toScreen} />}
      {gradient && <GradientPreview gradient={gradient} toScreen={toScreen} />}
      {crop && <CropOverlay crop={crop} />}
      {transform && <TransformOverlay st={transform} />}
      {shape && <ShapePreview shape={shape} toScreen={toScreen} />}
    </svg>
  );
}

type ToScreen = (x: number, y: number) => [number, number];

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
