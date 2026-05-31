/**
 * FiltersMenu — a Photoshop-style "Filter" menu dropdown listing every entry in
 * the FILTERS registry (in FILTER_ORDER). Selecting a filter opens its
 * FilterDialog, which drives a live preview against the active raster layer.
 *
 * Self-contained controller: it owns the menu open/close state and the active
 * filter dialog. App just mounts <FiltersMenu/> in the top bar.
 *
 * The trigger is disabled unless the active layer is a raster layer (filters
 * are destructive pixel ops and don't apply to adjustment layers).
 */
import { useEffect, useRef, useState } from "react";
import { useEngineSnapshot } from "../../state/useEngine";
import { FILTERS, FILTER_ORDER, type FilterType } from "../../engine/filters";
import { FilterDialog } from "./FilterDialog";

export function FiltersMenu() {
  const snap = useEngineSnapshot();
  const [menuOpen, setMenuOpen] = useState(false);
  const [activeFilter, setActiveFilter] = useState<FilterType | null>(null);
  const rootRef = useRef<HTMLDivElement | null>(null);

  // The active layer must be a raster layer for filters to apply.
  const active = snap.layers.find((l) => l.id === snap.activeLayerId) ?? null;
  const targetId =
    active && active.kind === "raster" ? active.id : null;
  const disabled = targetId === null;

  // Close the dropdown on outside click / Escape.
  useEffect(() => {
    if (!menuOpen) return;
    function onDown(e: MouseEvent) {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) {
        setMenuOpen(false);
      }
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setMenuOpen(false);
    }
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [menuOpen]);

  function pick(type: FilterType) {
    setMenuOpen(false);
    setActiveFilter(type);
  }

  return (
    <div className="relative" ref={rootRef}>
      <button
        className="btn"
        disabled={disabled}
        title={
          disabled
            ? "Select a raster layer to apply a filter"
            : "Filters"
        }
        onClick={() => setMenuOpen((o) => !o)}
      >
        Filter
        <svg
          width="9"
          height="9"
          viewBox="0 0 12 12"
          className="opacity-70"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
        >
          <path d="M2.5 4.5 6 8l3.5-3.5" />
        </svg>
      </button>

      {menuOpen && !disabled && (
        <div className="absolute left-0 top-full z-40 mt-1 w-48 overflow-hidden rounded-md border border-edge bg-panelraised py-1 shadow-2xl">
          {FILTER_ORDER.map((type) => (
            <button
              key={type}
              className="block w-full px-3 py-1.5 text-left text-xs text-ink transition-colors hover:bg-accent/20"
              onClick={() => pick(type)}
            >
              {FILTERS[type].label}
              {FILTERS[type].paramsSchema.length > 0 && (
                <span className="text-muted">…</span>
              )}
            </button>
          ))}
        </div>
      )}

      {activeFilter && targetId && (
        <FilterDialog
          type={activeFilter}
          layerId={targetId}
          onClose={() => setActiveFilter(null)}
        />
      )}
    </div>
  );
}
