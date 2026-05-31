/**
 * Levels editor.
 *
 * Renders the layer-below histogram and three draggable input handles (black /
 * gamma / white) under it, plus two output handles on a separate bar. Values map
 * 1:1 to the `levels` adjustment params (inBlack/inWhite 0..1, gamma 0.1..9.99,
 * outBlack/outWhite 0..1). Each drag emits live params via `onChange`; release
 * fires `onCommit` for a single undo step.
 */
import { useCallback, useEffect, useRef } from "react";

type Histo = { r: Uint32Array; g: Uint32Array; b: Uint32Array; luma: Uint32Array };

const W = 256;
const H = 96;

export interface LevelsEditorProps {
  params: Record<string, unknown>;
  /** Histogram of the layer the adjustment reads (below it), or null. */
  histogram: Histo | null;
  onChange: (patch: Record<string, number>) => void;
  onCommit?: () => void;
}

function num(v: unknown, fallback: number): number {
  return typeof v === "number" && Number.isFinite(v) ? v : fallback;
}
function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

export function LevelsEditor({ params, histogram, onChange, onCommit }: LevelsEditorProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  const inBlack = num(params.inBlack, 0);
  const inWhite = num(params.inWhite, 1);
  const gamma = num(params.gamma, 1);
  const outBlack = num(params.outBlack, 0);
  const outWhite = num(params.outWhite, 1);

  // ── draw histogram ──────────────────────────────────────
  useEffect(() => {
    const cv = canvasRef.current;
    if (!cv) return;
    const ctx = cv.getContext("2d");
    if (!ctx) return;
    ctx.clearRect(0, 0, W, H);
    ctx.fillStyle = "#16171a";
    ctx.fillRect(0, 0, W, H);
    if (!histogram) return;
    const bins = histogram.luma;
    let max = 1;
    for (let i = 0; i < 256; i++) if (bins[i]! > max) max = bins[i]!;
    // log scale tames spikes so the shape is readable
    const logMax = Math.log(1 + max);
    ctx.fillStyle = "#5b6068";
    for (let i = 0; i < 256; i++) {
      const v = Math.log(1 + bins[i]!) / logMax;
      const h = v * (H - 2);
      ctx.fillRect(i, H - h, 1, h);
    }
  }, [histogram]);

  // ── input-range handle drag ─────────────────────────────
  const inputBarRef = useRef<HTMLDivElement | null>(null);
  const dragRef = useRef<null | "black" | "gamma" | "white">(null);

  const onInputDown = useCallback(
    (handle: "black" | "gamma" | "white") => (e: React.PointerEvent) => {
      e.preventDefault();
      (e.target as HTMLElement).setPointerCapture(e.pointerId);
      dragRef.current = handle;
    },
    [],
  );

  const onInputMove = useCallback(
    (e: React.PointerEvent) => {
      const handle = dragRef.current;
      const bar = inputBarRef.current;
      if (!handle || !bar) return;
      const rect = bar.getBoundingClientRect();
      const t = clamp((e.clientX - rect.left) / rect.width, 0, 1);
      if (handle === "black") {
        const nb = clamp(t, 0, Math.min(inWhite - 0.004, 0.996));
        onChange({ inBlack: nb });
      } else if (handle === "white") {
        const nw = clamp(t, Math.max(inBlack + 0.004, 0.004), 1);
        onChange({ inWhite: nw });
      } else {
        // gamma handle sits between black/white; map its position to a gamma
        // exponent the same way Photoshop does (0.1 .. 9.99, midpoint = 1).
        const span = Math.max(1e-4, inWhite - inBlack);
        const mid = clamp((t - inBlack) / span, 0.001, 0.999);
        onChange({ gamma: clamp(mapMidToGamma(mid), 0.1, 9.99) });
      }
    },
    [inBlack, inWhite, onChange],
  );

  const endDrag = useCallback(
    (e: React.PointerEvent) => {
      if (!dragRef.current) return;
      dragRef.current = null;
      try {
        (e.target as HTMLElement).releasePointerCapture(e.pointerId);
      } catch {
        /* ignore */
      }
      onCommit?.();
    },
    [onCommit],
  );

  // gamma handle screen position: midpoint of [inBlack,inWhite] warped by gamma
  const gammaMid = gammaToMid(gamma);
  const gammaPos = inBlack + gammaMid * (inWhite - inBlack);

  // ── output-range handle drag ────────────────────────────
  const outBarRef = useRef<HTMLDivElement | null>(null);
  const outDragRef = useRef<null | "black" | "white">(null);
  const onOutDown = (handle: "black" | "white") => (e: React.PointerEvent) => {
    e.preventDefault();
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    outDragRef.current = handle;
  };
  const onOutMove = (e: React.PointerEvent) => {
    const handle = outDragRef.current;
    const bar = outBarRef.current;
    if (!handle || !bar) return;
    const rect = bar.getBoundingClientRect();
    const t = clamp((e.clientX - rect.left) / rect.width, 0, 1);
    if (handle === "black") onChange({ outBlack: clamp(t, 0, outWhite) });
    else onChange({ outWhite: clamp(t, outBlack, 1) });
  };
  const endOutDrag = (e: React.PointerEvent) => {
    if (!outDragRef.current) return;
    outDragRef.current = null;
    try {
      (e.target as HTMLElement).releasePointerCapture(e.pointerId);
    } catch {
      /* ignore */
    }
    onCommit?.();
  };

  return (
    <div className="flex flex-col gap-2">
      <canvas
        ref={canvasRef}
        width={W}
        height={H}
        className="w-full rounded-t border border-edge"
        style={{ display: "block" }}
      />

      {/* Input handles bar */}
      <div
        ref={inputBarRef}
        className="relative -mt-2 h-5 touch-none select-none rounded-b border border-t-0 border-edge bg-panelraised"
        onPointerMove={onInputMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
      >
        <Handle pos={inBlack} kind="black" onPointerDown={onInputDown("black")} title="Input black" />
        <Handle pos={gammaPos} kind="gamma" onPointerDown={onInputDown("gamma")} title="Gamma (midtones)" />
        <Handle pos={inWhite} kind="white" onPointerDown={onInputDown("white")} title="Input white" />
      </div>

      {/* Numeric readouts for input */}
      <div className="flex items-center justify-between text-[10px] tabular-nums text-muted">
        <span>{Math.round(inBlack * 255)}</span>
        <span>{gamma.toFixed(2)}</span>
        <span>{Math.round(inWhite * 255)}</span>
      </div>

      {/* Output gradient + handles */}
      <span className="mt-1 text-[10px] text-muted">Output</span>
      <div
        ref={outBarRef}
        className="relative h-5 touch-none select-none rounded border border-edge"
        style={{ background: "linear-gradient(to right, #000, #fff)" }}
        onPointerMove={onOutMove}
        onPointerUp={endOutDrag}
        onPointerCancel={endOutDrag}
      >
        <Handle pos={outBlack} kind="black" onPointerDown={onOutDown("black")} title="Output black" />
        <Handle pos={outWhite} kind="white" onPointerDown={onOutDown("white")} title="Output white" />
      </div>
      <div className="flex items-center justify-between text-[10px] tabular-nums text-muted">
        <span>{Math.round(outBlack * 255)}</span>
        <span>{Math.round(outWhite * 255)}</span>
      </div>
    </div>
  );
}

/** A draggable triangular handle anchored at fractional position `pos` (0..1). */
function Handle({
  pos,
  kind,
  onPointerDown,
  title,
}: {
  pos: number;
  kind: "black" | "white" | "gamma";
  onPointerDown: (e: React.PointerEvent) => void;
  title: string;
}) {
  const fill = kind === "black" ? "#0f1012" : kind === "white" ? "#e6e7ea" : "#9a9da4";
  return (
    <div
      role="slider"
      aria-label={title}
      title={title}
      onPointerDown={onPointerDown}
      className="absolute top-0 h-full w-3 -translate-x-1/2 cursor-ew-resize"
      style={{ left: `${pos * 100}%` }}
    >
      <svg viewBox="0 0 10 12" width="10" height="12" className="absolute left-1/2 top-0 -translate-x-1/2">
        <polygon points="5,0 10,8 0,8" fill={fill} stroke="#2c2e33" strokeWidth="1" />
      </svg>
    </div>
  );
}

// Photoshop maps the gamma handle's normalized midpoint `m` (0..1) to a gamma
// exponent `g` via g = log(0.5)/log(m). Inverse: m = 0.5^(1/g).
function gammaToMid(g: number): number {
  return Math.pow(0.5, 1 / clamp(g, 0.1, 9.99));
}
function mapMidToGamma(m: number): number {
  const mm = clamp(m, 0.001, 0.999);
  return Math.log(0.5) / Math.log(mm);
}
