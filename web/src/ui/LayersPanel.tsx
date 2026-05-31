/**
 * Layers panel — reads the engine snapshot, mutates only through engine
 * methods. Renders the layer TREE (groups + nesting) top -> bottom: a group row
 * is followed by its children (also top -> bottom), indented by depth. Supports
 * select / visibility / opacity / blend / mask / reorder / delete, plus
 * group / ungroup, clip-to-layer-below, and a layer-styles (fx) editor.
 *
 * The snapshot is a flat, depth-first list (Document.snapshot): each row carries
 * `depth`, `parentId`, `isGroup`, `collapsed?` and an `effects` summary. Children
 * of a COLLAPSED group are still present in the list (deeper depth) — we hide
 * them here using a running "collapsed depth" gate.
 */
import { useRef, useState } from "react";
import { useEngineSnapshot, actions } from "../state/useEngine";
import {
  BLEND_MODE_LABELS,
  type BlendMode,
  type LayerSnapshot,
} from "../model/Document";
import { ADJUSTMENTS } from "../engine/adjustments";
import { LayerStylesPanel } from "./layerstyles";

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

function ChevronIcon({ open }: { open: boolean }) {
  return (
    <svg
      width="12"
      height="12"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.5"
      className={`transition-transform ${open ? "" : "-rotate-90"}`}
    >
      <path d="M6 9l6 6 6-6" />
    </svg>
  );
}

function FolderIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
      <path d="M3 6a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6Z" />
    </svg>
  );
}

/**
 * Smart-object marker: a framed bitmap with the Photoshop-style corner badge,
 * signalling that the layer holds immutable original pixels behind a
 * non-destructive (lossless) transform.
 */
function SmartObjectIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
      <rect x="3" y="3" width="18" height="18" rx="2" />
      <path d="M3 17l5-5 4 4 3-3 6 6" />
      <rect x="14" y="14" width="9" height="9" rx="1.5" fill="currentColor" stroke="none" />
    </svg>
  );
}

export function LayersPanel() {
  const snap = useEngineSnapshot();
  const active = snap.layers.find((l) => l.id === snap.activeLayerId) ?? null;
  // Opacity value captured at drag-start so the whole drag is one undo step.
  const opacityDragStart = useRef<number | null>(null);
  // Which layer's styles editor is open (modal overlay), if any.
  const [stylesFor, setStylesFor] = useState<string | null>(null);

  // Hide descendants of collapsed groups: when a collapsed group at depth D is
  // emitted, skip every following row at depth > D until depth returns to <= D.
  const visible: LayerSnapshot[] = [];
  let hideBelowDepth = Infinity;
  for (const l of snap.layers) {
    if (l.depth > hideBelowDepth) continue; // inside a collapsed subtree
    hideBelowDepth = Infinity; // we are back out of any collapsed subtree
    visible.push(l);
    if (l.isGroup && l.collapsed) hideBelowDepth = l.depth;
  }

  const stylesLayer = stylesFor
    ? snap.layers.find((l) => l.id === stylesFor) ?? null
    : null;

  return (
    <div className="flex h-full flex-col">
      <div className="panel-title border-b border-edge">Layers</div>
      <div className="flex-1 overflow-y-auto">
        {snap.layers.length === 0 && (
          <p className="px-3 py-4 text-xs text-muted">
            No layers yet. Open an image or generate one.
          </p>
        )}
        {visible.map((l) => (
          <LayerRow
            key={l.id}
            layer={l}
            selected={l.id === snap.activeLayerId}
            opacityDragStart={opacityDragStart}
            onOpenStyles={() => setStylesFor(l.id)}
          />
        ))}
      </div>

      {/* Layer actions */}
      <div className="flex flex-wrap items-center gap-1.5 border-t border-edge p-2">
        <button
          className="btn"
          disabled={!snap.activeLayerId}
          onClick={() => snap.activeLayerId && actions.reorder(snap.activeLayerId, 1)}
          title="Move up (within its group)"
        >
          ↑
        </button>
        <button
          className="btn"
          disabled={!snap.activeLayerId}
          onClick={() => snap.activeLayerId && actions.reorder(snap.activeLayerId, -1)}
          title="Move down (within its group)"
        >
          ↓
        </button>

        {/* Group / ungroup. Multi-select doesn't exist yet, so "Group" wraps the
            active layer; if the active layer IS a group, the button ungroups it. */}
        {active && active.isGroup ? (
          <button
            className="btn"
            onClick={() => actions.ungroup(active.id)}
            title="Ungroup"
          >
            Ungroup
          </button>
        ) : (
          <button
            className="btn"
            onClick={() => {
              if (active) actions.groupLayers([active.id]);
              else actions.addGroup();
            }}
            title={active ? "Group the active layer" : "New empty group"}
          >
            Group
          </button>
        )}
        <button
          className="btn"
          onClick={() => actions.addGroup()}
          title="New empty group"
        >
          + Group
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

      {stylesLayer && (
        <LayerStylesPanel
          layerId={stylesLayer.id}
          layerName={stylesLayer.name}
          onClose={() => setStylesFor(null)}
        />
      )}
    </div>
  );
}

/**
 * True for layers that support clipping + layer styles + masks (raster / text /
 * smart). Smart objects reuse the full pixel-layer machinery in the engine, so
 * they get the same per-row controls as a raster layer.
 */
function isPixelKind(l: LayerSnapshot): boolean {
  return l.kind === "raster" || l.kind === "text" || l.kind === "smart";
}

/** Smart objects can be rasterized; raster/text layers can be wrapped into one. */
function isSmart(l: LayerSnapshot): boolean {
  return l.kind === "smart";
}
function canConvertToSmart(l: LayerSnapshot): boolean {
  return l.kind === "raster" || l.kind === "text";
}

/** True if any effect in the summary is active. */
function hasEffects(l: LayerSnapshot): boolean {
  const e = l.effects;
  return !!(
    e &&
    (e.dropShadow || e.innerShadow || e.stroke || e.outerGlow || e.colorOverlay)
  );
}

function LayerRow({
  layer: l,
  selected,
  opacityDragStart,
  onOpenStyles,
}: {
  layer: LayerSnapshot;
  selected: boolean;
  opacityDragStart: React.MutableRefObject<number | null>;
  onOpenStyles: () => void;
}) {
  const isAdjustment = l.kind === "adjustment";
  const isGroup = l.isGroup;
  const pixel = isPixelKind(l);
  const smart = isSmart(l) ? l.smart : null;
  const clippable = isAdjustment || pixel;
  // Lossless scale of a smart object relative to its immutable original size.
  const smartScalePct =
    smart && smart.naturalWidth > 0
      ? Math.round((smart.transform.sx || 1) * 100)
      : null;
  const typeLabel =
    isAdjustment && l.adjustmentType ? ADJUSTMENTS[l.adjustmentType].label : null;
  // Indent by nesting depth; clipped layers get an extra nudge so they read as
  // attached to the layer below them.
  const indentPx = 12 + l.depth * 14 + (l.clipping ? 10 : 0);

  return (
    <div
      onClick={() => actions.select(l.id)}
      style={{ paddingLeft: indentPx }}
      className={`flex cursor-pointer flex-col gap-1 border-b border-edge/60 py-2 pr-3 transition-colors ${
        selected ? "bg-accent/15" : "hover:bg-panelraised"
      }`}
    >
      <div className="flex items-center gap-1.5">
        {isGroup ? (
          <button
            className="text-muted hover:text-ink"
            onClick={(e) => {
              e.stopPropagation();
              actions.setGroupCollapsed(l.id, !l.collapsed);
            }}
            title={l.collapsed ? "Expand group" : "Collapse group"}
          >
            <ChevronIcon open={!l.collapsed} />
          </button>
        ) : (
          <span className="inline-block w-3" />
        )}
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
        {isGroup && (
          <span className="shrink-0 text-muted" title="Group">
            <FolderIcon />
          </span>
        )}
        {isAdjustment && (
          <span className="shrink-0 text-accent" title="Adjustment layer">
            <AdjustmentIcon />
          </span>
        )}
        {smart && (
          <span
            className="shrink-0 text-accent"
            title="Smart Object — non-destructive transform over immutable original pixels"
          >
            <SmartObjectIcon />
          </span>
        )}
        {l.clipping && (
          <span
            className="shrink-0 text-muted"
            title="Clipped to the layer below"
          >
            ⌐
          </span>
        )}
        <span className="flex-1 truncate text-sm">{l.name}</span>

        {pixel && hasEffects(l) && (
          <button
            onClick={(e) => {
              e.stopPropagation();
              onOpenStyles();
            }}
            title="Layer styles active — edit"
            className="rounded bg-accent/30 px-1 text-[9px] font-semibold uppercase tracking-wide text-ink"
          >
            fx
          </button>
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
        {smart && smartScalePct !== null && (
          <span
            className="shrink-0 rounded bg-panelraised px-1 text-[9px] font-semibold tabular-nums text-muted"
            title={`Scaled ${smartScalePct}% of the original ${smart.naturalWidth}×${smart.naturalHeight}px (lossless)`}
          >
            {smartScalePct}%
          </span>
        )}
        <span className="text-[10px] uppercase tracking-wide text-muted">
          {isGroup ? "group" : isAdjustment ? typeLabel : `${l.width}×${l.height}`}
        </span>
      </div>

      {/* Blend mode (all layer kinds carry one). */}
      <div className="flex items-center gap-2 pl-[18px]">
        <select
          value={l.blendMode}
          onClick={(e) => e.stopPropagation()}
          onChange={(e) => actions.setBlendMode(l.id, e.target.value as BlendMode)}
          className="min-w-0 flex-1 rounded border border-edge bg-panelraised px-1.5 py-0.5 text-[11px] outline-none focus:border-accent"
        >
          {BLEND_MODE_LABELS.map((b) => (
            <option key={b.mode} value={b.mode}>
              {b.label}
            </option>
          ))}
        </select>
      </div>

      {/* Opacity. */}
      <div className="flex items-center gap-2 pl-[18px]">
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
          onChange={(e) => actions.setOpacity(l.id, Number(e.target.value))}
          onPointerUp={(e) => {
            const from = opacityDragStart.current ?? l.opacity;
            opacityDragStart.current = null;
            actions.commitOpacity(l.id, from, Number((e.target as HTMLInputElement).value));
          }}
        />
        <span className="w-9 text-right text-[11px] tabular-nums text-muted">
          {Math.round(l.opacity * 100)}%
        </span>
      </div>

      {/* Per-layer style controls: clip-to-below + fx editor (pixel layers). */}
      {clippable && (
        <div
          className="flex items-center gap-3 pl-[18px]"
          onClick={(e) => e.stopPropagation()}
        >
          <label
            className="flex cursor-pointer items-center gap-1 text-[10px] text-muted"
            title="Clip this layer to the alpha of the layer directly below"
          >
            <input
              type="checkbox"
              checked={!!l.clipping}
              onChange={(e) => actions.setClipping(l.id, e.target.checked)}
              className="accent-accent"
            />
            Clip
          </label>
          {pixel && (
            <button
              onClick={onOpenStyles}
              className="rounded border border-edge bg-panelraised px-1.5 py-0.5 text-[10px] text-muted hover:text-ink"
              title="Edit layer styles (fx)"
            >
              fx…
            </button>
          )}
          {canConvertToSmart(l) && (
            <button
              onClick={() => actions.convertToSmartObject(l.id)}
              className="rounded border border-edge bg-panelraised px-1.5 py-0.5 text-[10px] text-muted hover:text-ink"
              title="Convert to Smart Object — wrap these pixels so Free Transform is lossless"
            >
              → Smart Object
            </button>
          )}
          {smart && (
            <button
              onClick={() => actions.rasterizeSmartObject(l.id)}
              className="rounded border border-edge bg-panelraised px-1.5 py-0.5 text-[10px] text-muted hover:text-ink"
              title="Rasterize — bake the current transform into a plain raster layer"
            >
              Rasterize
            </button>
          )}
        </div>
      )}
    </div>
  );
}
