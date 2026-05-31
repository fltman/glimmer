/**
 * Patterns popover. A self-mounted popover (triggered from a ToolOptions
 * "Patterns" button) that shows a grid of pattern swatches — each rendered from
 * the procedural pattern's own `draw()` via renderPatternTile() so the preview is
 * exactly what gets tiled — plus a scale slider, an opacity slider, and a
 * "Fill … with pattern" button.
 *
 *   · click a swatch → actions.setPattern(id) (selects the active pattern; also
 *     the pattern-stamp tool + fillWithPattern default).
 *   · scale / opacity sliders → actions.setPatternScale / setPatternOpacity.
 *   · "Fill" button → actions.fillWithPattern(activeRasterId, selectedId,
 *     {scale, opacity}). Disabled (with a hint) when the active layer isn't a
 *     raster layer; tiles the selection when one exists, else the whole layer.
 *
 * Pure UI: every mutation goes through `actions`; React never touches pixels.
 */
import { useEffect, useRef, useState } from "react";
import { actions, engine, useEngineSnapshot } from "../../state/useEngine";
import {
  usePatterns,
  usePatternState,
  renderPatternTile,
  type PatternDef,
} from "../../state/tools";

/**
 * A small canvas swatch that rasterizes one pattern tile (via renderPatternTile)
 * and tiles it across the swatch with `image-rendering: pixelated` so coarse
 * tiles stay crisp. This is the SAME tile the engine uploads, so the preview is
 * faithful. We draw on mount / when the def changes.
 */
function PatternSwatch({ def, size = 56 }: { def: PatternDef; size?: number }) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const cv = canvasRef.current;
    if (!cv) return;
    const ctx = cv.getContext("2d");
    if (!ctx) return;
    const img = renderPatternTile(def);
    if (!img) return;
    // Build a one-tile offscreen canvas, then tile it to fill the swatch with
    // CSS pixelation keeping the procedural edges crisp.
    const tile = document.createElement("canvas");
    tile.width = img.width;
    tile.height = img.height;
    tile.getContext("2d")?.putImageData(img, 0, 0);

    ctx.clearRect(0, 0, cv.width, cv.height);
    ctx.imageSmoothingEnabled = false;
    const pat = ctx.createPattern(tile, "repeat");
    if (pat) {
      ctx.fillStyle = pat;
      ctx.fillRect(0, 0, cv.width, cv.height);
    } else {
      // Fallback: manual tiling.
      for (let y = 0; y < cv.height; y += img.height) {
        for (let x = 0; x < cv.width; x += img.width) {
          ctx.drawImage(tile, x, y);
        }
      }
    }
  }, [def]);

  return (
    <canvas
      ref={canvasRef}
      width={size}
      height={size}
      className="block h-full w-full rounded"
      style={{ imageRendering: "pixelated" }}
    />
  );
}

/** One selectable pattern cell in the grid. */
function PatternCell({
  def,
  selected,
  onSelect,
}: {
  def: PatternDef;
  selected: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      title={`${def.name} · ${def.tileSize}px tile`}
      onClick={onSelect}
      className={`group flex flex-col items-stretch gap-1 rounded-md border p-1 transition-colors ${
        selected
          ? "border-accent bg-accent/10 ring-1 ring-accent/60"
          : "border-edge hover:border-edge/80 hover:bg-panelraised"
      }`}
    >
      <span className="aspect-square w-full overflow-hidden rounded border border-edge/60">
        <PatternSwatch def={def} />
      </span>
      <span
        className={`truncate text-center text-[10px] leading-tight ${
          selected ? "text-ink" : "text-muted group-hover:text-ink"
        }`}
      >
        {def.name}
      </span>
    </button>
  );
}

/** A compact labelled slider matching the dark popover style. */
function PopSlider({
  label,
  value,
  min,
  max,
  step,
  fmt,
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  fmt: (v: number) => string;
  onChange: (v: number) => void;
}) {
  return (
    <label className="flex items-center gap-2">
      <span className="w-12 text-[11px] text-muted">{label}</span>
      <input
        type="range"
        className="flex-1"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
      />
      <span className="w-12 text-right text-[11px] tabular-nums text-muted">
        {fmt(value)}
      </span>
    </label>
  );
}

/**
 * The patterns popover body. `onClose` closes after a fill. Subscribes to the
 * engine snapshot so the Fill button enablement (active raster layer) and the
 * selection/layer hint stay live.
 */
function PatternsPopoverBody({ onClose }: { onClose: () => void }) {
  const patterns = usePatterns();
  const { selectedId, scale, opacity } = usePatternState();
  // Watch the engine so the active-raster gate + selection hint track edits.
  useEngineSnapshot();
  const rasterId = engine.getActiveRasterLayerId();
  const hasSel = engine.hasSelection();

  const doFill = () => {
    if (!rasterId) return;
    actions.fillWithPattern(rasterId, selectedId, { scale, opacity });
    onClose();
  };

  return (
    <div className="w-72 rounded-md border border-edge bg-panel p-2 shadow-xl">
      <div className="mb-1.5 px-1 text-[11px] font-semibold uppercase tracking-wider text-muted">
        Patterns
      </div>

      <div className="grid max-h-64 grid-cols-3 gap-1.5 overflow-y-auto pr-0.5">
        {patterns.map((def) => (
          <PatternCell
            key={def.id}
            def={def}
            selected={def.id === selectedId}
            onSelect={() => actions.setPattern(def.id)}
          />
        ))}
      </div>

      <div className="mt-2 flex flex-col gap-1.5 border-t border-edge pt-2">
        <PopSlider
          label="Scale"
          value={scale}
          min={0.05}
          max={8}
          step={0.05}
          fmt={(v) => `${Math.round(v * 100)}%`}
          onChange={(v) => actions.setPatternScale(v)}
        />
        <PopSlider
          label="Opacity"
          value={opacity}
          min={0}
          max={1}
          step={0.01}
          fmt={(v) => `${Math.round(v * 100)}%`}
          onChange={(v) => actions.setPatternOpacity(v)}
        />
      </div>

      <div className="mt-2 flex items-center gap-2 border-t border-edge pt-2">
        <button
          type="button"
          className="btn-accent flex-1"
          disabled={!rasterId}
          title={
            rasterId
              ? hasSel
                ? "Tile the pattern across the selection"
                : "Tile the pattern across the whole layer"
              : "Select a pixel (raster) layer to fill"
          }
          onClick={doFill}
        >
          {rasterId
            ? hasSel
              ? "Fill selection with pattern"
              : "Fill layer with pattern"
            : "Select a raster layer"}
        </button>
      </div>
    </div>
  );
}

/**
 * Self-mounted Patterns button + popover. Drop it straight into a ToolOptions bar
 * — it owns its own open/close state, outside-click + Escape dismissal, and
 * renders the popover absolutely below the button (no App.tsx wiring needed).
 */
export function PatternsButton({ label = "Patterns" }: { label?: string }) {
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
        title="Choose a pattern, set scale/opacity, and fill"
        onClick={(e) => {
          e.stopPropagation();
          setOpen((o) => !o);
        }}
        className={`btn ${open ? "ring-1 ring-accent" : ""}`}
      >
        {label} ▾
      </button>
      {open && (
        <div
          className="absolute left-0 top-full z-50 mt-2"
          onPointerDown={(e) => e.stopPropagation()}
        >
          <PatternsPopoverBody onClose={() => setOpen(false)} />
        </div>
      )}
    </div>
  );
}
