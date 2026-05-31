/**
 * GradientStopsEditor — compact editor for a `gradient` ParamField (used by
 * gradient_map). Renders a live gradient preview bar with draggable stop markers
 * plus per-stop color/position controls. Stops are { pos, color:{r,g,b,a} } in
 * sRGB straight, exactly what the registry's buildLUT consumes. Each edit emits
 * the full stops array (live) and commits one undo step on release.
 */
import { useRef } from "react";
import type { GradientStop } from "../../engine/adjustments";
import { hexToRgba, rgbaToHex, rgbaToCss } from "./colorUtil";

export interface GradientStopsEditorProps {
  stops: GradientStop[];
  onChange: (next: GradientStop[]) => void;
  onCommit: () => void;
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

function sorted(stops: GradientStop[]): GradientStop[] {
  return [...stops].sort((a, b) => a.pos - b.pos);
}

/** CSS linear-gradient() string for the preview bar. */
function cssGradient(stops: GradientStop[]): string {
  const s = sorted(stops);
  if (s.length === 0) return "#000";
  const parts = s.map((st) => `${rgbaToCss(st.color)} ${(clamp01(st.pos) * 100).toFixed(1)}%`);
  return `linear-gradient(to right, ${parts.join(", ")})`;
}

export function GradientStopsEditor({ stops, onChange, onCommit }: GradientStopsEditorProps) {
  const barRef = useRef<HTMLDivElement | null>(null);
  const dragRef = useRef<number | null>(null);
  const list = sorted(stops);

  function localT(e: React.PointerEvent): number {
    const bar = barRef.current!;
    const rect = bar.getBoundingClientRect();
    return clamp01((e.clientX - rect.left) / rect.width);
  }

  function onBarDown(e: React.PointerEvent) {
    // click on empty bar (not a marker) adds a stop sampled from the gradient
    if ((e.target as HTMLElement).dataset.stopIndex) return;
    const t = localT(e);
    const col = sampleAt(list, t);
    const next = sorted([...list, { pos: t, color: col }]);
    onChange(next);
    onCommit();
  }

  function onMarkerDown(index: number) {
    return (e: React.PointerEvent) => {
      e.stopPropagation();
      (e.target as HTMLElement).setPointerCapture(e.pointerId);
      dragRef.current = index;
    };
  }
  function onMarkerMove(e: React.PointerEvent) {
    const i = dragRef.current;
    if (i === null) return;
    const t = localT(e);
    const next = list.map((st, idx) => (idx === i ? { ...st, pos: t } : st));
    onChange(sorted(next));
  }
  function onMarkerUp(e: React.PointerEvent) {
    if (dragRef.current === null) return;
    dragRef.current = null;
    try {
      (e.target as HTMLElement).releasePointerCapture(e.pointerId);
    } catch {
      /* ignore */
    }
    onCommit();
  }

  function setStopColor(index: number, hex: string) {
    const next = list.map((st, idx) =>
      idx === index ? { ...st, color: hexToRgba(hex, st.color.a) } : st,
    );
    onChange(next);
    onCommit();
  }
  function setStopPos(index: number, pos: number) {
    const next = list.map((st, idx) => (idx === index ? { ...st, pos: clamp01(pos) } : st));
    onChange(sorted(next));
    onCommit();
  }
  function removeStop(index: number) {
    if (list.length <= 2) return; // keep at least two stops
    const next = list.filter((_, idx) => idx !== index);
    onChange(next);
    onCommit();
  }

  return (
    <div className="flex flex-col gap-2">
      <div
        ref={barRef}
        className="relative h-6 cursor-copy touch-none rounded border border-edge"
        style={{ background: cssGradient(list) }}
        onPointerDown={onBarDown}
        onPointerMove={onMarkerMove}
        onPointerUp={onMarkerUp}
        onPointerCancel={onMarkerUp}
        title="Click to add a stop"
      >
        {list.map((st, i) => (
          <div
            key={i}
            data-stop-index={i}
            onPointerDown={onMarkerDown(i)}
            className="absolute top-0 h-full w-2.5 -translate-x-1/2 cursor-ew-resize rounded border border-ink/70"
            style={{ left: `${clamp01(st.pos) * 100}%`, background: rgbaToCss(st.color) }}
            title={`Stop ${Math.round(st.pos * 100)}%`}
          />
        ))}
      </div>

      <div className="flex flex-col gap-1.5">
        {list.map((st, i) => (
          <div key={i} className="flex items-center gap-2">
            <input
              type="color"
              value={rgbaToHex(st.color)}
              onChange={(e) => setStopColor(i, e.target.value)}
              className="h-5 w-7 cursor-pointer rounded border border-edge bg-panelraised"
            />
            <input
              type="number"
              min={0}
              max={100}
              step={1}
              value={Math.round(st.pos * 100)}
              onChange={(e) => setStopPos(i, Number(e.target.value) / 100)}
              className="w-14 rounded border border-edge bg-panelraised px-1 py-0.5 text-right text-[11px] tabular-nums outline-none focus:border-accent"
            />
            <span className="text-[10px] text-muted">%</span>
            <div className="flex-1" />
            <button
              onClick={() => removeStop(i)}
              disabled={list.length <= 2}
              className="rounded border border-edge bg-panelraised px-1.5 text-[11px] text-muted hover:text-ink disabled:opacity-30"
              title="Remove stop"
            >
              ×
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}

/** Sample the gradient color at t (0..1) for newly inserted stops. */
function sampleAt(stops: GradientStop[], t: number): GradientStop["color"] {
  const s = sorted(stops);
  if (s.length === 0) return { r: 0, g: 0, b: 0, a: 1 };
  if (t <= s[0]!.pos) return { ...s[0]!.color };
  if (t >= s[s.length - 1]!.pos) return { ...s[s.length - 1]!.color };
  for (let i = 0; i < s.length - 1; i++) {
    const a = s[i]!;
    const b = s[i + 1]!;
    if (t >= a.pos && t <= b.pos) {
      const span = b.pos - a.pos;
      const f = span > 1e-6 ? (t - a.pos) / span : 0;
      return {
        r: a.color.r + (b.color.r - a.color.r) * f,
        g: a.color.g + (b.color.g - a.color.g) * f,
        b: a.color.b + (b.color.b - a.color.b) * f,
        a: a.color.a + (b.color.a - a.color.a) * f,
      };
    }
  }
  return { ...s[s.length - 1]!.color };
}
