/**
 * Mounts a single <canvas> exactly once and hands it to the singleton engine.
 * The canvas is NEVER remounted — a remount would destroy the GL context and
 * the document with it. React only owns the wrapping <div>'s layout.
 *
 * An SVG overlay (synced to the engine's view transform via rAF) draws the
 * in-progress marquee/lasso outline crisply under zoom. The committed selection
 * contour's marching ants are drawn in GL by the engine. The cursor reflects
 * the active tool.
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
  hand: "grab",
};

/** Live selection-in-progress outline, in CSS px relative to the canvas. */
function SelectionOverlay() {
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
  const toScreen = (x: number, y: number) => [
    x * view.scale + view.tx,
    y * view.scale + view.ty,
  ];

  const marquee = engine.getLiveMarquee();
  const lasso = engine.getLiveLasso();
  if (!marquee && !lasso) return null;

  return (
    <svg className="pointer-events-none absolute inset-0 h-full w-full">
      {marquee &&
        (() => {
          const [sx0, sy0] = toScreen(marquee.x0, marquee.y0);
          const [sx1, sy1] = toScreen(marquee.x1, marquee.y1);
          const x = Math.min(sx0!, sx1!);
          const y = Math.min(sy0!, sy1!);
          const w = Math.abs(sx1! - sx0!);
          const h = Math.abs(sy1! - sy0!);
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
        })()}
      {lasso && lasso.length >= 4 && (
        <polyline
          points={(() => {
            const pts: string[] = [];
            for (let i = 0; i < lasso.length; i += 2) {
              const [sx, sy] = toScreen(lasso[i]!, lasso[i + 1]!);
              pts.push(`${sx},${sy}`);
            }
            return pts.join(" ");
          })()}
          fill="rgba(91,140,255,0.08)"
          stroke="white"
          strokeWidth={1}
          strokeDasharray="5 4"
        />
      )}
    </svg>
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
      <SelectionOverlay />
    </div>
  );
}
