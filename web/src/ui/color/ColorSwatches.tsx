/**
 * ColorSwatches — the foreground/background color chips, Photoshop-style:
 * two overlapping squares (foreground on top), a small swap arrow and a
 * default-reset chip. Clicking a square opens the ColorPicker popover bound to
 * that slot. Bound to the engine's foreground/background state via useColors().
 *
 * Keyboard (when not typing in an input): X swaps, D resets to black/white.
 *
 * Pure UI — every mutation goes through `actions` (toolStore under the hood).
 */
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { actions, useColors } from "../../state/useEngine";
import type { RGBAColor } from "../../state/tools";
import { ColorPicker } from "./ColorPicker";
import { rgbaCss } from "./colorMath";

type Slot = "foreground" | "background";

/** A single color chip with a checkerboard backing for transparency. */
function Chip({
  color,
  onClick,
  className,
  title,
}: {
  color: RGBAColor;
  onClick: (e: React.MouseEvent) => void;
  className: string;
  title: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      className={`absolute h-7 w-7 rounded-[3px] border border-black/40 shadow ring-1 ring-white/10 ${className}`}
      style={{
        // Checkerboard so alpha is legible, with the color painted on top.
        backgroundImage: `linear-gradient(${rgbaCss(color)}, ${rgbaCss(color)}), linear-gradient(45deg, #777 25%, transparent 25%), linear-gradient(-45deg, #777 25%, transparent 25%), linear-gradient(45deg, transparent 75%, #777 75%), linear-gradient(-45deg, transparent 75%, #777 75%)`,
        backgroundSize: "100% 100%, 8px 8px, 8px 8px, 8px 8px, 8px 8px",
        backgroundPosition: "0 0, 0 0, 0 4px, 4px -4px, -4px 0",
      }}
    />
  );
}

export function ColorSwatches() {
  const { foreground, background } = useColors();
  const [open, setOpen] = useState<Slot | null>(null);
  const rootRef = useRef<HTMLDivElement | null>(null);
  // The picker is portalled to <body> with fixed positioning so it escapes the
  // tool-rail's overflow/stacking context and never opens off the bottom of the
  // screen (the swatches sit at the foot of the rail). Anchored to the right of
  // the swatches, growing upward from their bottom edge.
  const [pickerPos, setPickerPos] = useState<{ left: number; bottom: number } | null>(null);
  useLayoutEffect(() => {
    if (!open) {
      setPickerPos(null);
      return;
    }
    const r = rootRef.current?.getBoundingClientRect();
    if (r) setPickerPos({ left: r.right + 8, bottom: window.innerHeight - r.bottom });
  }, [open]);

  // Close the popover on outside click / Escape.
  useEffect(() => {
    if (!open) return;
    function onDown(e: PointerEvent) {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) {
        setOpen(null);
      }
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(null);
    }
    window.addEventListener("pointerdown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("pointerdown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  // X = swap, D = reset (ignored while typing).
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const el = e.target as HTMLElement | null;
      if (el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable)) {
        return;
      }
      const k = e.key.toLowerCase();
      if (k === "x") {
        actions.swapColors();
      } else if (k === "d") {
        actions.resetColors();
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const activeColor = open === "background" ? background : foreground;
  const onPickerChange = (c: RGBAColor) => {
    if (open === "background") actions.setBackground(c);
    else actions.setForeground(c);
  };

  return (
    <div ref={rootRef} className="relative flex items-center gap-1.5">
      {/* Overlapping swatch stack */}
      <div className="relative h-12 w-12">
        <Chip
          color={background}
          title="Background color (click to edit)"
          className={`bottom-0 right-0 ${open === "background" ? "ring-2 ring-accent" : ""}`}
          onClick={(e) => {
            e.stopPropagation();
            setOpen((s) => (s === "background" ? null : "background"));
          }}
        />
        <Chip
          color={foreground}
          title="Foreground color (click to edit)"
          className={`left-0 top-0 z-10 ${open === "foreground" ? "ring-2 ring-accent" : ""}`}
          onClick={(e) => {
            e.stopPropagation();
            setOpen((s) => (s === "foreground" ? null : "foreground"));
          }}
        />
      </div>

      {/* Swap + reset controls */}
      <div className="flex flex-col gap-0.5">
        <button
          type="button"
          title="Swap foreground / background (X)"
          onClick={() => actions.swapColors()}
          className="flex h-4 w-4 items-center justify-center rounded text-[11px] leading-none text-muted transition-colors hover:bg-panelraised hover:text-ink"
        >
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M16 3h5v5" />
            <path d="M21 3 14 10" />
            <path d="M8 21H3v-5" />
            <path d="M3 21 10 14" />
          </svg>
        </button>
        <button
          type="button"
          title="Reset to black / white (D)"
          onClick={() => actions.resetColors()}
          className="flex h-4 w-4 items-center justify-center rounded transition-colors hover:bg-panelraised"
        >
          {/* tiny black-over-white default chip */}
          <span className="relative block h-3 w-3">
            <span className="absolute bottom-0 right-0 h-2 w-2 rounded-[1px] border border-black/40 bg-white" />
            <span className="absolute left-0 top-0 h-2 w-2 rounded-[1px] border border-white/40 bg-black" />
          </span>
        </button>
      </div>

      {/* Picker popover — portalled so it escapes the rail's clipping/stacking. */}
      {open &&
        pickerPos &&
        createPortal(
          <div
            style={{ position: "fixed", left: pickerPos.left, bottom: pickerPos.bottom }}
            className="z-[200]"
            onPointerDown={(e) => e.stopPropagation()}
          >
            <ColorPicker
              value={activeColor}
              onChange={onPickerChange}
              onEyedropper={() => setOpen(null)}
            />
          </div>,
          document.body,
        )}
    </div>
  );
}
