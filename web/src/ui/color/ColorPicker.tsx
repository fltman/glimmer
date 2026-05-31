/**
 * ColorPicker — a real HSV color picker popover.
 *
 *   ┌───────────────┬──┐
 *   │  SV square    │H │   SV square: saturation (x) × value (y)
 *   │  (drag)       │u │   Hue strip:  hue (vertical drag)
 *   │               │e │   Alpha strip (optional)
 *   └───────────────┴──┘
 *   HEX  R G B  (numeric)   + eyedropper button
 *
 * Fully controlled: it takes the current `value` (sRGB straight 0..1) and emits
 * `onChange` on every edit. Hue is tracked locally so dragging the SV square at
 * S=0 / V=0 (where RGB→HSV hue is undefined) doesn't snap the hue back to 0.
 *
 * Pure UI — never touches pixels. The eyedropper button just activates the
 * engine's 'eyedropper' tool (the engine wires the click→sample→setForeground).
 */
import { useCallback, useEffect, useRef, useState } from "react";
import type { RGBAColor } from "../../state/tools";
import { toolStore } from "../../state/tools";
import {
  clamp01,
  hexToRgb,
  hsvToRgb,
  rgb255,
  rgbCss,
  rgbToHex,
  rgbToHsv,
  type HSV,
} from "./colorMath";

interface ColorPickerProps {
  value: RGBAColor;
  onChange: (c: RGBAColor) => void;
  /** Show the alpha strip + alpha numeric input. Defaults to true. */
  showAlpha?: boolean;
  /** Called when the eyedropper button is pressed (after the tool is set). */
  onEyedropper?: () => void;
}

/** Track pointer drags within a box, reporting normalized 0..1 coordinates. */
function useDragArea(onMove: (nx: number, ny: number) => void) {
  const ref = useRef<HTMLDivElement | null>(null);
  const draggingRef = useRef(false);

  const report = useCallback(
    (clientX: number, clientY: number) => {
      const el = ref.current;
      if (!el) return;
      const r = el.getBoundingClientRect();
      const nx = clamp01((clientX - r.left) / r.width);
      const ny = clamp01((clientY - r.top) / r.height);
      onMove(nx, ny);
    },
    [onMove],
  );

  useEffect(() => {
    function move(e: PointerEvent) {
      if (!draggingRef.current) return;
      e.preventDefault();
      report(e.clientX, e.clientY);
    }
    function up() {
      draggingRef.current = false;
    }
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    return () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
  }, [report]);

  const onPointerDown = useCallback(
    (e: React.PointerEvent) => {
      e.preventDefault();
      draggingRef.current = true;
      report(e.clientX, e.clientY);
    },
    [report],
  );

  return { ref, onPointerDown };
}

function NumInput({
  label,
  value,
  min,
  max,
  onCommit,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  onCommit: (v: number) => void;
}) {
  // Local string state so the user can clear the field mid-edit.
  const [text, setText] = useState(String(value));
  useEffect(() => setText(String(value)), [value]);

  const commit = (raw: string) => {
    const n = Number(raw);
    if (raw.trim() === "" || Number.isNaN(n)) {
      setText(String(value));
      return;
    }
    const clamped = Math.min(max, Math.max(min, Math.round(n)));
    setText(String(clamped));
    onCommit(clamped);
  };

  return (
    <label className="flex flex-1 flex-col items-center gap-1">
      <span className="text-[10px] uppercase tracking-wide text-muted">{label}</span>
      <input
        type="text"
        inputMode="numeric"
        value={text}
        onChange={(e) => setText(e.target.value)}
        onBlur={(e) => commit(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") (e.target as HTMLInputElement).blur();
        }}
        className="w-full rounded border border-edge bg-panelraised px-1 py-1 text-center text-[11px] tabular-nums outline-none focus:border-accent"
      />
    </label>
  );
}

export function ColorPicker({
  value,
  onChange,
  showAlpha = true,
  onEyedropper,
}: ColorPickerProps) {
  // Locally-tracked hue (degrees). Reconciled from `value` whenever the value's
  // chroma is high enough to define a hue, so external edits stay in sync but
  // grayscale drags don't reset the strip.
  const [hue, setHue] = useState(() => rgbToHsv(value).h);
  useEffect(() => {
    const hsv = rgbToHsv(value);
    if (hsv.s > 0.001 && hsv.v > 0.001) setHue(hsv.h);
  }, [value]);

  const current = rgbToHsv(value);
  const sv: HSV = { h: hue, s: current.s, v: current.v };
  const rgb = rgb255(value);
  const hexText = rgbToHex(value);

  const emitHsv = useCallback(
    (next: HSV) => {
      onChange(hsvToRgb(next, value.a));
    },
    [onChange, value.a],
  );

  const svArea = useDragArea((nx, ny) => {
    setHue(hue);
    emitHsv({ h: hue, s: nx, v: 1 - ny });
  });
  const hueArea = useDragArea((_nx, ny) => {
    const h = ny * 360;
    setHue(h);
    emitHsv({ h, s: sv.s, v: sv.v });
  });
  const alphaArea = useDragArea((nx) => {
    onChange({ ...value, a: nx });
  });

  // Hue-only base color for the SV square background gradient.
  const hueBase = rgbCss(hsvToRgb({ h: hue, s: 1, v: 1 }, 1));
  const opaque = rgbCss(value);

  const [hexDraft, setHexDraft] = useState(hexText);
  useEffect(() => setHexDraft(hexText), [hexText]);

  return (
    <div className="flex w-60 flex-col gap-3 rounded-lg border border-edge bg-panel p-3 shadow-2xl">
      <div className="flex gap-2">
        {/* SV square */}
        <div
          ref={svArea.ref}
          onPointerDown={svArea.onPointerDown}
          className="relative h-40 flex-1 cursor-crosshair touch-none rounded"
          style={{ background: hueBase }}
        >
          {/* white→transparent (saturation) over black→transparent (value) */}
          <div
            className="pointer-events-none absolute inset-0 rounded"
            style={{ background: "linear-gradient(to right, #fff, rgba(255,255,255,0))" }}
          />
          <div
            className="pointer-events-none absolute inset-0 rounded"
            style={{ background: "linear-gradient(to top, #000, rgba(0,0,0,0))" }}
          />
          <div
            className="pointer-events-none absolute h-3 w-3 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-white shadow"
            style={{
              left: `${sv.s * 100}%`,
              top: `${(1 - sv.v) * 100}%`,
              boxShadow: "0 0 0 1px rgba(0,0,0,0.5)",
            }}
          />
        </div>

        {/* Hue strip */}
        <div
          ref={hueArea.ref}
          onPointerDown={hueArea.onPointerDown}
          className="relative h-40 w-4 cursor-pointer touch-none rounded"
          style={{
            background:
              "linear-gradient(to bottom, #ff0000 0%, #ffff00 17%, #00ff00 33%, #00ffff 50%, #0000ff 67%, #ff00ff 83%, #ff0000 100%)",
          }}
        >
          <div
            className="pointer-events-none absolute left-1/2 h-2 w-[140%] -translate-x-1/2 -translate-y-1/2 rounded-sm border border-white"
            style={{ top: `${(hue / 360) * 100}%`, boxShadow: "0 0 0 1px rgba(0,0,0,0.5)" }}
          />
        </div>

        {/* Alpha strip */}
        {showAlpha && (
          <div
            ref={alphaArea.ref}
            onPointerDown={alphaArea.onPointerDown}
            className="relative h-40 w-4 cursor-pointer touch-none rounded"
            style={{
              backgroundImage:
                "linear-gradient(45deg, #555 25%, transparent 25%), linear-gradient(-45deg, #555 25%, transparent 25%), linear-gradient(45deg, transparent 75%, #555 75%), linear-gradient(-45deg, transparent 75%, #555 75%)",
              backgroundSize: "8px 8px",
              backgroundPosition: "0 0, 0 4px, 4px -4px, -4px 0",
            }}
          >
            <div
              className="pointer-events-none absolute inset-0 rounded"
              style={{ background: `linear-gradient(to bottom, ${opaque}, rgba(0,0,0,0))` }}
            />
            <div
              className="pointer-events-none absolute left-1/2 h-2 w-[140%] -translate-x-1/2 -translate-y-1/2 rounded-sm border border-white"
              style={{ top: `${value.a * 100}%`, boxShadow: "0 0 0 1px rgba(0,0,0,0.5)" }}
            />
          </div>
        )}
      </div>

      {/* HEX + eyedropper */}
      <div className="flex items-end gap-2">
        <label className="flex flex-1 flex-col gap-1">
          <span className="text-[10px] uppercase tracking-wide text-muted">Hex</span>
          <input
            type="text"
            value={hexDraft}
            onChange={(e) => setHexDraft(e.target.value)}
            onBlur={(e) => {
              const parsed = hexToRgb(e.target.value, value.a);
              if (parsed) onChange(parsed);
              else setHexDraft(hexText);
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") (e.target as HTMLInputElement).blur();
            }}
            className="w-full rounded border border-edge bg-panelraised px-2 py-1 text-[11px] tabular-nums uppercase outline-none focus:border-accent"
          />
        </label>
        <button
          type="button"
          title="Pick a color from the canvas (eyedropper)"
          onClick={() => {
            toolStore.setActive("eyedropper");
            onEyedropper?.();
          }}
          className="flex h-[30px] w-[30px] items-center justify-center rounded-md border border-edge bg-panelraised text-muted transition-colors hover:bg-edge hover:text-ink"
        >
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="m2 22 1-1h3l9-9" />
            <path d="M3 21v-3l9-9" />
            <path d="m15 6 3.4-3.4a2.1 2.1 0 1 1 3 3L18 9l.4.4a2.1 2.1 0 1 1-3 3l-3.8-3.8a2.1 2.1 0 1 1 3-3l.4.4Z" />
          </svg>
        </button>
      </div>

      {/* RGB(A) numeric inputs */}
      <div className="flex gap-2">
        <NumInput label="R" value={rgb.r} min={0} max={255} onCommit={(v) => onChange({ ...value, r: v / 255 })} />
        <NumInput label="G" value={rgb.g} min={0} max={255} onCommit={(v) => onChange({ ...value, g: v / 255 })} />
        <NumInput label="B" value={rgb.b} min={0} max={255} onCommit={(v) => onChange({ ...value, b: v / 255 })} />
        {showAlpha && (
          <NumInput
            label="A"
            value={Math.round(value.a * 100)}
            min={0}
            max={100}
            onCommit={(v) => onChange({ ...value, a: v / 100 })}
          />
        )}
      </div>
    </div>
  );
}
