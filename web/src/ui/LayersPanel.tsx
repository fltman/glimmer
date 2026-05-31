/**
 * Layers panel — reads the engine snapshot, mutates only through engine
 * methods. Lists layers top->bottom, supports select / visibility / opacity /
 * reorder / delete.
 */
import { useRef } from "react";
import { useEngineSnapshot, actions } from "../state/useEngine";
import { BLEND_MODE_LABELS, type BlendMode } from "../model/Document";
import { ADJUSTMENTS } from "../engine/adjustments";

/** Small half-filled circle marking a non-destructive adjustment layer. */
function AdjustmentIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" aria-hidden>
      <circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" strokeWidth="2" />
      <path d="M12 3a9 9 0 0 0 0 18Z" fill="currentColor" />
    </svg>
  );
}

function EyeIcon({ open }: { open: boolean }) {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      {open ? (
        <>
          <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7Z" />
          <circle cx="12" cy="12" r="3" />
        </>
      ) : (
        <>
          <path d="M3 3l18 18" />
          <path d="M10.6 5.1A10 10 0 0 1 12 5c6.5 0 10 7 10 7a16 16 0 0 1-3.2 3.7M6.6 6.6A16 16 0 0 0 2 12s3.5 7 10 7a10 10 0 0 0 3.4-.6" />
        </>
      )}
    </svg>
  );
}

export function LayersPanel() {
  const snap = useEngineSnapshot();
  const active = snap.layers.find((l) => l.id === snap.activeLayerId) ?? null;
  // Opacity value captured at drag-start so the whole drag is one undo step.
  const opacityDragStart = useRef<number | null>(null);

  return (
    <div className="flex h-full flex-col">
      <div className="panel-title border-b border-edge">Layers</div>
      <div className="flex-1 overflow-y-auto">
        {snap.layers.length === 0 && (
          <p className="px-3 py-4 text-xs text-muted">
            No layers yet. Open an image or generate one.
          </p>
        )}
        {snap.layers.map((l) => {
          const selected = l.id === snap.activeLayerId;
          const isAdjustment = l.kind === "adjustment";
          const typeLabel =
            isAdjustment && l.adjustmentType
              ? ADJUSTMENTS[l.adjustmentType].label
              : null;
          return (
            <div
              key={l.id}
              onClick={() => actions.select(l.id)}
              className={`flex cursor-pointer flex-col gap-1 border-b border-edge/60 px-3 py-2 transition-colors ${
                selected ? "bg-accent/15" : "hover:bg-panelraised"
              }`}
            >
              <div className="flex items-center gap-2">
                <button
                  className="text-muted hover:text-ink"
                  onClick={(e) => {
                    e.stopPropagation();
                    actions.toggleVisible(l.id, !l.visible);
                  }}
                  title={l.visible ? "Hide" : "Show"}
                >
                  <EyeIcon open={l.visible} />
                </button>
                {isAdjustment && (
                  <span
                    className="shrink-0 text-accent"
                    title="Adjustment layer"
                  >
                    <AdjustmentIcon />
                  </span>
                )}
                <span className="flex-1 truncate text-sm">{l.name}</span>
                {isAdjustment && l.clipping && (
                  <span
                    className="shrink-0 text-muted"
                    title="Clipped to the layer below"
                  >
                    ↳
                  </span>
                )}
                {l.hasMask && (
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      actions.toggleMaskEnabled(l.id, !l.maskEnabled);
                    }}
                    title={l.maskEnabled ? "Disable mask" : "Enable mask"}
                    className={`rounded px-1 text-[9px] font-semibold uppercase tracking-wide ${
                      l.maskEnabled
                        ? "bg-accent/30 text-ink"
                        : "bg-edge text-muted line-through"
                    }`}
                  >
                    mask
                  </button>
                )}
                <span className="text-[10px] uppercase tracking-wide text-muted">
                  {isAdjustment ? typeLabel : `${l.width}×${l.height}`}
                </span>
              </div>

              {/* Blend mode + opacity */}
              <div className="flex items-center gap-2 pl-6">
                <select
                  value={l.blendMode}
                  onClick={(e) => e.stopPropagation()}
                  onChange={(e) =>
                    actions.setBlendMode(l.id, e.target.value as BlendMode)
                  }
                  className="min-w-0 flex-1 rounded border border-edge bg-panelraised px-1.5 py-0.5 text-[11px] outline-none focus:border-accent"
                >
                  {BLEND_MODE_LABELS.map((b) => (
                    <option key={b.mode} value={b.mode}>
                      {b.label}
                    </option>
                  ))}
                </select>
              </div>
              <div className="flex items-center gap-2 pl-6">
                <input
                  type="range"
                  min={0}
                  max={1}
                  step={0.01}
                  value={l.opacity}
                  onClick={(e) => e.stopPropagation()}
                  onPointerDown={() => {
                    opacityDragStart.current = l.opacity;
                  }}
                  onChange={(e) =>
                    actions.setOpacity(l.id, Number(e.target.value))
                  }
                  onPointerUp={(e) => {
                    const from = opacityDragStart.current ?? l.opacity;
                    opacityDragStart.current = null;
                    actions.commitOpacity(
                      l.id,
                      from,
                      Number((e.target as HTMLInputElement).value),
                    );
                  }}
                />
                <span className="w-9 text-right text-[11px] tabular-nums text-muted">
                  {Math.round(l.opacity * 100)}%
                </span>
              </div>
            </div>
          );
        })}
      </div>
      {/* Layer actions */}
      <div className="flex items-center gap-1.5 border-t border-edge p-2">
        <button
          className="btn"
          disabled={!snap.activeLayerId}
          onClick={() => snap.activeLayerId && actions.reorder(snap.activeLayerId, 1)}
          title="Move up"
        >
          ↑
        </button>
        <button
          className="btn"
          disabled={!snap.activeLayerId}
          onClick={() => snap.activeLayerId && actions.reorder(snap.activeLayerId, -1)}
          title="Move down"
        >
          ↓
        </button>
        {active && !active.hasMask && (
          <button
            className="btn"
            onClick={() => actions.addMaskFromSelection(active.id)}
            title="Add layer mask from selection"
          >
            + Mask
          </button>
        )}
        {active && active.hasMask && (
          <button
            className="btn"
            onClick={() => actions.removeMask(active.id)}
            title="Remove layer mask"
          >
            − Mask
          </button>
        )}
        <div className="flex-1" />
        <button
          className="btn"
          disabled={!snap.activeLayerId}
          onClick={() => snap.activeLayerId && actions.remove(snap.activeLayerId)}
          title="Delete layer"
        >
          Delete
        </button>
      </div>
    </div>
  );
}
