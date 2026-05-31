/**
 * Brush dynamics popover ("Brush ▾"). Houses the advanced shape-dynamics
 * controls that don't fit in the compact options bar: Roundness, Angle,
 * Spacing, Scatter, Size Jitter, the Textured toggle, and the Pressure→Size /
 * Pressure→Opacity toggles. Reads the live brush via useBrushParams() and writes
 * every change through actions.setBrushParams (which patches toolStore.brush).
 *
 * Self-mounted: owns its open/close state + outside-click/Escape dismissal and
 * renders the popover absolutely below the trigger, so it drops straight into
 * the brush options bar with no App.tsx wiring.
 */
import { useEffect, useRef, useState } from "react";
import { actions } from "../../state/useEngine";
import { useBrushParams } from "../../state/tools";

/** A compact labelled slider matching the options-bar style (vertical stack). */
function Row({
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
      <span className="w-20 text-[11px] text-muted">{label}</span>
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

/** A toggle row (checkbox + label) for the boolean dynamics. */
function ToggleRow({
  label,
  checked,
  title,
  onChange,
}: {
  label: string;
  checked: boolean;
  title?: string;
  onChange: (v: boolean) => void;
}) {
  return (
    <label
      title={title}
      className="flex cursor-pointer items-center gap-2 text-[11px] text-muted"
    >
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        className="h-3 w-3 accent-accent"
      />
      <span>{label}</span>
    </label>
  );
}

/** The popover body — all dynamics controls, bound to the live brush. */
function DynamicsBody() {
  const brush = useBrushParams();
  // The dynamics fields are optional on BrushParams; fall back to the neutral
  // soft-round defaults so the controls always have a concrete value to show.
  const roundness = brush.roundness ?? 1;
  const angle = brush.angle ?? 0;
  const spacing = brush.spacing ?? 10;
  const scatter = brush.scatter ?? 0;
  const sizeJitter = brush.sizeJitter ?? 0;

  return (
    <div className="flex w-64 flex-col gap-2 rounded-md border border-edge bg-panel p-3 shadow-xl">
      <div className="text-[11px] font-semibold uppercase tracking-wider text-muted">
        Brush Dynamics
      </div>
      <Row
        label="Roundness"
        value={roundness}
        min={0.05}
        max={1}
        step={0.01}
        fmt={(v) => `${Math.round(v * 100)}%`}
        onChange={(v) => actions.setBrushParams({ roundness: v })}
      />
      <Row
        label="Angle"
        value={angle}
        min={-180}
        max={180}
        step={1}
        fmt={(v) => `${Math.round(v)}°`}
        onChange={(v) => actions.setBrushParams({ angle: v })}
      />
      <Row
        label="Spacing"
        value={spacing}
        min={1}
        max={200}
        step={1}
        fmt={(v) => `${Math.round(v)}%`}
        onChange={(v) => actions.setBrushParams({ spacing: v })}
      />
      <Row
        label="Scatter"
        value={scatter}
        min={0}
        max={1}
        step={0.01}
        fmt={(v) => `${Math.round(v * 100)}%`}
        onChange={(v) => actions.setBrushParams({ scatter: v })}
      />
      <Row
        label="Size Jitter"
        value={sizeJitter}
        min={0}
        max={1}
        step={0.01}
        fmt={(v) => `${Math.round(v * 100)}%`}
        onChange={(v) => actions.setBrushParams({ sizeJitter: v })}
      />
      <div className="mt-1 flex flex-col gap-1.5 border-t border-edge pt-2">
        <ToggleRow
          label="Textured tip (chalk)"
          checked={brush.textured ?? false}
          title="Modulate the tip alpha with procedural noise for a chalky/grainy stroke"
          onChange={(v) => actions.setBrushParams({ textured: v })}
        />
        <ToggleRow
          label="Pressure → Size"
          checked={brush.pressureSize ?? false}
          title="Map pen pressure to dab diameter"
          onChange={(v) => actions.setBrushParams({ pressureSize: v })}
        />
        <ToggleRow
          label="Pressure → Opacity"
          checked={brush.pressureOpacity ?? false}
          title="Map pen pressure to dab opacity/flow"
          onChange={(v) => actions.setBrushParams({ pressureOpacity: v })}
        />
      </div>
    </div>
  );
}

/** Self-mounted "Brush ▾" trigger + dynamics popover. */
export function BrushDynamicsButton() {
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
        title="Brush dynamics (roundness, angle, spacing, scatter, pressure)"
        onClick={(e) => {
          e.stopPropagation();
          setOpen((o) => !o);
        }}
        className={`btn ${open ? "ring-1 ring-accent" : ""}`}
      >
        Brush ▾
      </button>
      {open && (
        <div
          className="absolute left-0 top-full z-50 mt-2"
          onPointerDown={(e) => e.stopPropagation()}
        >
          <DynamicsBody />
        </div>
      )}
    </div>
  );
}
