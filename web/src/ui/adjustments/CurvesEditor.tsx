/**
 * Interactive Curves editor.
 *
 * Draws a 256x256 grid + the four channel curves and lets the user drag
 * control points for the active channel (RGB / R / G / B). Points are the same
 * { x, y } 0..1 representation the `curves` adjustment registry consumes; on any
 * edit we emit the WHOLE params object (all four channel arrays) to `onChange`
 * so the engine rebuilds its LUT. Editing matches Photoshop: click an empty spot
 * to add a point, drag to move, drag a non-endpoint off the graph to delete.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import type { CurvePoint } from "../../engine/adjustments";

type Channel = "rgb" | "r" | "g" | "b";

const CHANNELS: { key: Channel; label: string; color: string }[] = [
  { key: "rgb", label: "RGB", color: "#e6e7ea" },
  { key: "r", label: "R", color: "#ff6b6b" },
  { key: "g", label: "G", color: "#51cf66" },
  { key: "b", label: "B", color: "#5b8cff" },
];

const SIZE = 256; // logical drawing size (square)
const HIT_RADIUS = 10; // px (logical) to grab a point
const DELETE_DIST = 28; // px (logical) outside the graph before a point is dropped

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

function defaultLine(): CurvePoint[] {
  return [
    { x: 0, y: 0 },
    { x: 1, y: 1 },
  ];
}

/** Sorted, x-monotone copy (endpoints keep their x pinned at 0 / 1). */
function sortPoints(pts: CurvePoint[]): CurvePoint[] {
  return [...pts].sort((a, b) => a.x - b.x);
}

export interface CurvesEditorProps {
  /** Full curves params: keys rgb/r/g/b each holding a CurvePoint[]. */
  params: Record<string, unknown>;
  /** Emits the full next params object (live) — wire to updateAdjustmentParams. */
  onChange: (next: Record<string, CurvePoint[]>) => void;
  /** Called once on drag-release to record a single undo step. */
  onCommit?: () => void;
}

function readChannel(params: Record<string, unknown>, ch: Channel): CurvePoint[] {
  const v = params[ch];
  if (Array.isArray(v) && v.length >= 2) {
    return v.map((p) => ({ x: clamp01((p as CurvePoint).x), y: clamp01((p as CurvePoint).y) }));
  }
  return defaultLine();
}

export function CurvesEditor({ params, onChange, onCommit }: CurvesEditorProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [channel, setChannel] = useState<Channel>("rgb");
  const dragRef = useRef<{ index: number } | null>(null);

  const allChannels = useCallback(
    (): Record<Channel, CurvePoint[]> => ({
      rgb: readChannel(params, "rgb"),
      r: readChannel(params, "r"),
      g: readChannel(params, "g"),
      b: readChannel(params, "b"),
    }),
    [params],
  );

  // ── canvas <-> data space ──────────────────────────────
  const toCanvas = useCallback((p: CurvePoint): { x: number; y: number } => {
    return { x: p.x * SIZE, y: (1 - p.y) * SIZE };
  }, []);

  // ── draw ────────────────────────────────────────────────
  useEffect(() => {
    const cv = canvasRef.current;
    if (!cv) return;
    const ctx = cv.getContext("2d");
    if (!ctx) return;
    const ch = allChannels();

    ctx.clearRect(0, 0, SIZE, SIZE);
    ctx.fillStyle = "#16171a";
    ctx.fillRect(0, 0, SIZE, SIZE);

    // grid
    ctx.strokeStyle = "#2c2e33";
    ctx.lineWidth = 1;
    for (let i = 1; i < 4; i++) {
      const t = (i / 4) * SIZE;
      ctx.beginPath();
      ctx.moveTo(t, 0);
      ctx.lineTo(t, SIZE);
      ctx.moveTo(0, t);
      ctx.lineTo(SIZE, t);
      ctx.stroke();
    }
    // identity diagonal
    ctx.strokeStyle = "#3a3c42";
    ctx.beginPath();
    ctx.moveTo(0, SIZE);
    ctx.lineTo(SIZE, 0);
    ctx.stroke();

    // inactive channels (dim) then active channel (bright + handles)
    const order: Channel[] = ["rgb", "r", "g", "b"];
    for (const k of order) {
      if (k === channel) continue;
      drawCurve(ctx, sortPoints(ch[k]), channelColor(k), 1, 0.35, toCanvas);
    }
    drawCurve(ctx, sortPoints(ch[channel]), channelColor(channel), 1.75, 1, toCanvas);

    // handles for active channel
    const pts = sortPoints(ch[channel]);
    for (const p of pts) {
      const c = toCanvas(p);
      ctx.beginPath();
      ctx.arc(c.x, c.y, 4, 0, Math.PI * 2);
      ctx.fillStyle = "#0f1012";
      ctx.fill();
      ctx.lineWidth = 2;
      ctx.strokeStyle = channelColor(channel);
      ctx.stroke();
    }
  }, [params, channel, allChannels, toCanvas]);

  // ── pointer interaction ─────────────────────────────────
  function localPoint(e: React.PointerEvent): { x: number; y: number } {
    const cv = canvasRef.current!;
    const rect = cv.getBoundingClientRect();
    return {
      x: ((e.clientX - rect.left) / rect.width) * SIZE,
      y: ((e.clientY - rect.top) / rect.height) * SIZE,
    };
  }

  function emit(pts: CurvePoint[]) {
    const ch = allChannels();
    onChange({ ...ch, [channel]: sortPoints(pts) });
  }

  function onPointerDown(e: React.PointerEvent) {
    e.preventDefault();
    (e.target as HTMLCanvasElement).setPointerCapture(e.pointerId);
    const lp = localPoint(e);
    const pts = sortPoints(allChannels()[channel]);

    // grab an existing point?
    let hit = -1;
    for (let i = 0; i < pts.length; i++) {
      const c = toCanvas(pts[i]!);
      if (Math.hypot(c.x - lp.x, c.y - lp.y) <= HIT_RADIUS) {
        hit = i;
        break;
      }
    }
    if (hit >= 0) {
      dragRef.current = { index: hit };
      return;
    }

    // otherwise add a new point at the clicked x
    const nx = clamp01(lp.x / SIZE);
    const ny = clamp01(1 - lp.y / SIZE);
    const next = [...pts, { x: nx, y: ny }];
    const sorted = sortPoints(next);
    dragRef.current = { index: sorted.findIndex((p) => p.x === nx && p.y === ny) };
    emit(sorted);
  }

  function onPointerMove(e: React.PointerEvent) {
    const drag = dragRef.current;
    if (!drag) return;
    const lp = localPoint(e);
    const pts = sortPoints(allChannels()[channel]);
    const i = drag.index;
    if (i < 0 || i >= pts.length) return;
    const isEndpoint = i === 0 || i === pts.length - 1;

    // dragging an interior point far outside the graph deletes it
    if (
      !isEndpoint &&
      (lp.x < -DELETE_DIST || lp.x > SIZE + DELETE_DIST || lp.y < -DELETE_DIST || lp.y > SIZE + DELETE_DIST)
    ) {
      const next = pts.filter((_, idx) => idx !== i);
      dragRef.current = null;
      emit(next);
      return;
    }

    let nx = clamp01(lp.x / SIZE);
    const ny = clamp01(1 - lp.y / SIZE);
    // endpoints keep their x pinned (0 / 1); interior points stay between neighbors
    if (i === 0) nx = 0;
    else if (i === pts.length - 1) nx = 1;
    else {
      const lo = pts[i - 1]!.x + 0.001;
      const hi = pts[i + 1]!.x - 0.001;
      nx = Math.min(Math.max(nx, lo), hi);
    }
    const next = pts.map((p, idx) => (idx === i ? { x: nx, y: ny } : p));
    emit(next);
  }

  function endDrag(e: React.PointerEvent) {
    if (!dragRef.current) return;
    dragRef.current = null;
    try {
      (e.target as HTMLCanvasElement).releasePointerCapture(e.pointerId);
    } catch {
      /* capture may already be gone */
    }
    onCommit?.();
  }

  function resetChannel() {
    const ch = allChannels();
    onChange({ ...ch, [channel]: defaultLine() });
    onCommit?.();
  }

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-1">
        {CHANNELS.map((c) => (
          <button
            key={c.key}
            onClick={() => setChannel(c.key)}
            className={`flex-1 rounded border px-1.5 py-0.5 text-[11px] font-medium transition-colors ${
              channel === c.key
                ? "border-accent bg-accent/20 text-ink"
                : "border-edge bg-panelraised text-muted hover:text-ink"
            }`}
            style={channel === c.key ? undefined : { color: c.key === "rgb" ? undefined : c.color }}
            title={`Edit ${c.label} curve`}
          >
            {c.label}
          </button>
        ))}
      </div>
      <canvas
        ref={canvasRef}
        width={SIZE}
        height={SIZE}
        className="w-full touch-none rounded border border-edge"
        style={{ aspectRatio: "1 / 1", imageRendering: "auto" }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
      />
      <div className="flex items-center justify-between">
        <span className="text-[10px] text-muted">
          Click to add · drag · drag out to remove
        </span>
        <button
          onClick={resetChannel}
          className="rounded border border-edge bg-panelraised px-1.5 py-0.5 text-[10px] text-muted hover:text-ink"
        >
          Reset
        </button>
      </div>
    </div>
  );
}

function channelColor(ch: Channel): string {
  return CHANNELS.find((c) => c.key === ch)!.color;
}

/** Linear-segment polyline of a curve across the canvas (matches the LUT eval). */
function drawCurve(
  ctx: CanvasRenderingContext2D,
  pts: CurvePoint[],
  color: string,
  width: number,
  alpha: number,
  toCanvas: (p: CurvePoint) => { x: number; y: number },
) {
  if (pts.length === 0) return;
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.strokeStyle = color;
  ctx.lineWidth = width;
  ctx.beginPath();
  const first = toCanvas(pts[0]!);
  // flat lead-in from the left edge
  ctx.moveTo(0, first.y);
  ctx.lineTo(first.x, first.y);
  for (let i = 1; i < pts.length; i++) {
    const c = toCanvas(pts[i]!);
    ctx.lineTo(c.x, c.y);
  }
  // flat trail-out to the right edge
  const last = toCanvas(pts[pts.length - 1]!);
  ctx.lineTo(SIZE, last.y);
  ctx.stroke();
  ctx.restore();
}
