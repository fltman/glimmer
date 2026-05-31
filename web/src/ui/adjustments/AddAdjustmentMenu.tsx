/**
 * AddAdjustmentMenu — a dropdown of every adjustment type (driven by the
 * registry's ADJUSTMENT_ORDER + labels). Picking one inserts a non-destructive
 * adjustment layer above the active layer via the engine (one undo step) and
 * selects it so its properties open immediately.
 */
import { useEffect, useRef, useState } from "react";
import { ADJUSTMENTS, ADJUSTMENT_ORDER } from "../../engine/adjustments";
import { actions } from "../../state/useEngine";

export function AddAdjustmentMenu() {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    function onDown(e: MouseEvent) {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    window.addEventListener("mousedown", onDown);
    return () => window.removeEventListener("mousedown", onDown);
  }, [open]);

  return (
    <div ref={rootRef} className="relative">
      <button
        className="btn w-full justify-center"
        onClick={() => setOpen((o) => !o)}
        title="Add a non-destructive adjustment layer"
      >
        + Adjustment
        <svg width="10" height="10" viewBox="0 0 10 10" className="opacity-70">
          <path d="M2 3.5 5 6.5 8 3.5" fill="none" stroke="currentColor" strokeWidth="1.4" />
        </svg>
      </button>

      {open && (
        <div className="absolute left-0 right-0 top-full z-20 mt-1 max-h-72 overflow-y-auto rounded-md border border-edge bg-panelraised py-1 shadow-lg shadow-black/40">
          {ADJUSTMENT_ORDER.map((type) => (
            <button
              key={type}
              onClick={() => {
                actions.addAdjustmentLayer(type);
                setOpen(false);
              }}
              className="block w-full px-3 py-1.5 text-left text-xs text-ink transition-colors hover:bg-accent/20"
            >
              {ADJUSTMENTS[type].label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
