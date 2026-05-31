/**
 * Swatches panel — a grid of saved color chips, Photoshop-style.
 *
 * Reads the engine's saved-swatch list reactively via `useSwatches()` and the
 * current foreground via `useColors()`. Interactions:
 *   - click a chip      → set the foreground color,
 *   - shift-click a chip → set the background color,
 *   - right-click a chip → remove it (also a small ✕ on hover),
 *   - "+" tile           → add the current foreground as a new swatch,
 *   - reset              → restore the built-in default swatches.
 *
 * Pure UI — all mutations go through the engine `actions.*` API (swatchStore /
 * toolStore under the hood). React never touches pixels.
 */
import { actions, useColors } from "../../state/useEngine";
import { useSwatches } from "../../state/tools";
import type { RGBAColor } from "../../state/tools";
import { rgbaCss } from "../color/colorMath";

/** A checkerboard backing + the swatch color on top, so alpha is legible. */
function chipBackground(color: RGBAColor): React.CSSProperties {
  return {
    backgroundImage: `linear-gradient(${rgbaCss(color)}, ${rgbaCss(color)}), linear-gradient(45deg, #777 25%, transparent 25%), linear-gradient(-45deg, #777 25%, transparent 25%), linear-gradient(45deg, transparent 75%, #777 75%), linear-gradient(-45deg, transparent 75%, #777 75%)`,
    backgroundSize: "100% 100%, 8px 8px, 8px 8px, 8px 8px, 8px 8px",
    backgroundPosition: "0 0, 0 0, 0 4px, 4px -4px, -4px 0",
  };
}

export function SwatchesPanel() {
  const swatches = useSwatches();
  const { foreground } = useColors();

  return (
    <div className="flex h-full flex-col">
      <div className="panel-title flex items-center justify-between border-b border-edge">
        <span>Swatches</span>
        <button
          type="button"
          title="Reset to default swatches"
          onClick={() => actions.resetSwatches()}
          className="text-[10px] font-normal normal-case tracking-normal text-muted transition-colors hover:text-ink"
        >
          reset
        </button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto p-2">
        <div className="grid grid-cols-8 gap-1.5">
          {swatches.map((c, i) => {
            return (
              <button
                key={`${i}-${c.r}-${c.g}-${c.b}-${c.a}`}
                type="button"
                title="Click: set foreground · Shift-click: set background · Right-click: remove"
                onClick={(e) => {
                  if (e.shiftKey) actions.setBackground(c);
                  else actions.setForeground(c);
                }}
                onContextMenu={(e) => {
                  e.preventDefault();
                  actions.removeSwatch(i);
                }}
                className="group relative aspect-square rounded-[3px] border border-black/40 ring-1 ring-white/10 transition-transform hover:scale-110 hover:ring-accent"
                style={chipBackground(c)}
              >
                {/* Hover ✕ to remove. */}
                <span
                  onClick={(e) => {
                    e.stopPropagation();
                    actions.removeSwatch(i);
                  }}
                  className="absolute right-0 top-0 flex h-3 w-3 -translate-y-1/3 translate-x-1/3 items-center justify-center rounded-full bg-panel text-[9px] leading-none text-ink opacity-0 ring-1 ring-edge transition-opacity group-hover:opacity-100"
                >
                  ×
                </span>
              </button>
            );
          })}

          {/* "+" tile — add the current foreground as a new swatch. */}
          <button
            type="button"
            title="Add the current foreground color as a swatch"
            onClick={() => actions.addSwatch(foreground)}
            className="flex aspect-square items-center justify-center rounded-[3px] border border-dashed border-edge text-muted transition-colors hover:border-accent hover:text-ink"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round">
              <path d="M12 5v14M5 12h14" />
            </svg>
          </button>
        </div>

        {swatches.length === 0 && (
          <p className="mt-3 px-1 text-[11px] leading-relaxed text-muted">
            No swatches. Add the current foreground color with the “+” tile.
          </p>
        )}
      </div>

      <div className="shrink-0 border-t border-edge px-3 py-2 text-[10px] leading-snug text-muted">
        Click sets foreground · Shift-click sets background · Right-click removes
      </div>
    </div>
  );
}
