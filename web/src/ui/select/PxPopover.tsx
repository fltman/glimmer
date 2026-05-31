/**
 * PxPopover — a tiny inline numeric popover used by the Select menu's
 * Feather / Expand / Contract items. It anchors below its trigger row, shows a
 * single numeric input (pixels) plus Apply / Cancel, and commits via `onApply`.
 *
 * It is intentionally dumb: it owns only the draft value and its own
 * outside-click / Escape dismissal. The Select menu owns which popover is open.
 * React never touches pixels — Apply just calls the engine action passed in.
 */
import { useEffect, useRef, useState } from "react";

export interface PxPopoverProps {
  /** Heading shown above the input (e.g. "Feather selection"). */
  title: string;
  /** Initial value for the numeric input. */
  initial: number;
  /** Clamp bounds for the input. */
  min: number;
  max: number;
  /** Label for the value (e.g. "Radius", "Amount"). */
  label?: string;
  /** Commit handler — receives the clamped pixel value. */
  onApply: (px: number) => void;
  /** Dismiss without applying. */
  onClose: () => void;
}

export function PxPopover({
  title,
  initial,
  min,
  max,
  label = "Pixels",
  onApply,
  onClose,
}: PxPopoverProps) {
  const [value, setValue] = useState<number>(initial);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);

  // Focus + select the input on mount for fast keyboard entry.
  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);

  // Dismiss on outside click / Escape.
  useEffect(() => {
    function onDown(e: MouseEvent) {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) {
        onClose();
      }
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [onClose]);

  const clamped = Math.min(max, Math.max(min, Number.isFinite(value) ? value : min));

  function apply() {
    onApply(clamped);
    onClose();
  }

  return (
    <div
      ref={rootRef}
      className="absolute left-full top-0 z-50 ml-1 w-52 rounded-md border border-edge bg-panelraised p-3 shadow-2xl"
      // Stop clicks from bubbling to the parent menu's outside-click handler.
      onMouseDown={(e) => e.stopPropagation()}
    >
      <div className="mb-2 text-xs font-semibold text-ink">{title}</div>
      <label className="mb-1 block text-[10px] font-medium uppercase tracking-wider text-muted">
        {label}
      </label>
      <div className="flex items-center gap-2">
        <input
          ref={inputRef}
          type="number"
          min={min}
          max={max}
          value={Number.isFinite(value) ? value : ""}
          onChange={(e) => setValue(Number(e.target.value))}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              apply();
            }
          }}
          className="w-full rounded border border-edge bg-[#0f1012] px-2 py-1 text-xs tabular-nums text-ink outline-none focus:border-accent"
        />
        <span className="text-xs text-muted">px</span>
      </div>
      <div className="mt-3 flex justify-end gap-2">
        <button className="btn" onClick={onClose}>
          Cancel
        </button>
        <button className="btn btn-accent" onClick={apply}>
          Apply
        </button>
      </div>
    </div>
  );
}
