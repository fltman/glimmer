/**
 * Brush presets popover. A self-mounted popover (triggered from the ToolOptions
 * "Presets" button) that lists the brush presets from useBrushPresets() — built-
 * ins plus any user-saved ones — each with a tiny SVG preview stroke reflecting
 * its size / hardness / roundness / angle / textured flags.
 *
 *   · click a preset row → actions.applyBrushPreset(id) (copies its params onto
 *     the live brush) and closes the popover.
 *   · "Save current"     → actions.addBrushPreset(name) (captures the live brush).
 *   · the X on a non-builtin → actions.removeBrushPreset(id).
 *
 * Pure UI: every mutation goes through `actions`; React never touches pixels.
 */
import { useEffect, useRef, useState } from "react";
import { actions } from "../../state/useEngine";
import { useBrushPresets, type BrushPreset } from "../../state/tools";

/**
 * A small SVG swatch that visualises a preset's tip. We draw a tapered stroke
 * whose tip is an ellipse (roundness squashes the minor axis, angle rotates it)
 * with a soft/hard radial edge (hardness) and an optional speckle for textured
 * tips. It's schematic — enough to tell presets apart at a glance.
 */
function PresetSwatch({ preset }: { preset: BrushPreset }) {
  const W = 96;
  const H = 28;
  const p = preset.params;
  const hardness = Math.max(0, Math.min(1, p.hardness));
  const roundness = Math.max(0.05, Math.min(1, p.roundness ?? 1));
  const angle = p.angle ?? 0;
  // Visual tip radius scaled from the brush size (clamped so it fits the swatch).
  const r = Math.max(3, Math.min(H / 2 - 2, 3 + (p.size / 512) * (H / 2 - 4)));
  // The soft edge: a hard tip is a near-solid disc, a soft tip fades out.
  const innerStop = Math.round(hardness * 70);
  const gradId = `bp-grad-${preset.id}`;
  const speckleId = `bp-speckle-${preset.id}`;
  // Lay several dabs along the stroke to suggest spacing/scatter visually.
  const cy = H / 2;
  const dabs = [0.18, 0.4, 0.62, 0.84];

  return (
    <svg
      width={W}
      height={H}
      viewBox={`0 0 ${W} ${H}`}
      className="rounded bg-panel"
      style={{ flex: "0 0 auto" }}
    >
      <defs>
        <radialGradient id={gradId} cx="50%" cy="50%" r="50%">
          <stop offset="0%" stopColor="#e6e7ea" stopOpacity={1} />
          <stop offset={`${innerStop}%`} stopColor="#e6e7ea" stopOpacity={1} />
          <stop offset="100%" stopColor="#e6e7ea" stopOpacity={0} />
        </radialGradient>
        {p.textured && (
          <pattern
            id={speckleId}
            width="4"
            height="4"
            patternUnits="userSpaceOnUse"
          >
            <rect width="4" height="4" fill="#e6e7ea" fillOpacity="0.0" />
            <circle cx="1" cy="1" r="0.6" fill="#e6e7ea" fillOpacity="0.9" />
            <circle cx="3" cy="3" r="0.5" fill="#e6e7ea" fillOpacity="0.6" />
          </pattern>
        )}
      </defs>
      {dabs.map((t, i) => {
        const cx = 8 + t * (W - 16);
        return (
          <g
            key={i}
            transform={`translate(${cx} ${cy}) rotate(${angle}) scale(1 ${roundness})`}
          >
            <ellipse
              cx={0}
              cy={0}
              rx={r}
              ry={r}
              fill={p.textured ? `url(#${speckleId})` : `url(#${gradId})`}
            />
          </g>
        );
      })}
    </svg>
  );
}

/** One row in the presets list. */
function PresetRow({
  preset,
  onApply,
  onRemove,
}: {
  preset: BrushPreset;
  onApply: () => void;
  onRemove?: () => void;
}) {
  return (
    <div className="group flex items-center gap-2 rounded px-1.5 py-1 hover:bg-panelraised">
      <button
        type="button"
        title={`Apply "${preset.name}" (${Math.round(preset.params.size)}px)`}
        onClick={onApply}
        className="flex flex-1 items-center gap-2 text-left"
      >
        <PresetSwatch preset={preset} />
        <span className="flex min-w-0 flex-col leading-tight">
          <span className="truncate text-[11px] text-ink">{preset.name}</span>
          <span className="text-[10px] tabular-nums text-muted">
            {Math.round(preset.params.size)}px ·{" "}
            {Math.round(preset.params.hardness * 100)}% hard
            {preset.params.textured ? " · textured" : ""}
          </span>
        </span>
      </button>
      {onRemove ? (
        <button
          type="button"
          title="Delete this preset"
          onClick={(e) => {
            e.stopPropagation();
            onRemove();
          }}
          className="flex h-4 w-4 shrink-0 items-center justify-center rounded text-[11px] leading-none text-muted opacity-0 transition-colors hover:bg-edge hover:text-ink group-hover:opacity-100"
        >
          ×
        </button>
      ) : (
        <span
          title="Built-in preset"
          className="shrink-0 text-[9px] uppercase tracking-wider text-muted/60"
        >
          built-in
        </span>
      )}
    </div>
  );
}

/**
 * The presets popover body. `onClose` closes it after an apply. Renders the
 * list, a "Save current" name field, and per-preset remove for non-builtins.
 */
function PresetsPopoverBody({ onClose }: { onClose: () => void }) {
  const presets = useBrushPresets();
  const [name, setName] = useState("");

  const saveCurrent = () => {
    actions.addBrushPreset(name.trim() || "My Brush");
    setName("");
  };

  return (
    <div className="w-64 rounded-md border border-edge bg-panel p-2 shadow-xl">
      <div className="mb-1 px-1 text-[11px] font-semibold uppercase tracking-wider text-muted">
        Brush Presets
      </div>
      <div className="max-h-72 overflow-y-auto pr-0.5">
        {presets.map((preset) => (
          <PresetRow
            key={preset.id}
            preset={preset}
            onApply={() => {
              actions.applyBrushPreset(preset.id);
              onClose();
            }}
            onRemove={
              preset.builtin
                ? undefined
                : () => actions.removeBrushPreset(preset.id)
            }
          />
        ))}
      </div>
      <div className="mt-2 flex items-center gap-1.5 border-t border-edge pt-2">
        <input
          type="text"
          value={name}
          placeholder="New preset name…"
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              saveCurrent();
            }
          }}
          className="min-w-0 flex-1 rounded border border-edge bg-panelraised px-1.5 py-1 text-[11px] text-ink placeholder:text-muted/60"
        />
        <button
          type="button"
          title="Save the current brush as a new preset"
          onClick={saveCurrent}
          className="btn-accent shrink-0"
        >
          Save
        </button>
      </div>
    </div>
  );
}

/**
 * Self-mounted presets button + popover. Drop it straight into the brush options
 * bar — it owns its own open/close state, outside-click + Escape dismissal, and
 * renders the popover absolutely below the button (no App.tsx wiring needed).
 */
export function BrushPresetsButton() {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    function onDown(e: PointerEvent) {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    window.addEventListener("pointerdown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("pointerdown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div ref={rootRef} className="relative inline-flex">
      <button
        type="button"
        title="Brush presets"
        onClick={(e) => {
          e.stopPropagation();
          setOpen((o) => !o);
        }}
        className={`btn ${open ? "ring-1 ring-accent" : ""}`}
      >
        Presets ▾
      </button>
      {open && (
        <div
          className="absolute left-0 top-full z-50 mt-2"
          onPointerDown={(e) => e.stopPropagation()}
        >
          <PresetsPopoverBody onClose={() => setOpen(false)} />
        </div>
      )}
    </div>
  );
}
