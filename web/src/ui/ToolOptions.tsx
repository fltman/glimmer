/**
 * Tool options bar — context-sensitive parameters for the active tool.
 * Brush/Eraser: size, opacity, hardness, flow. Marquee/Lasso: feather + a
 * "Deselect" action. Reads/writes only the tool store and the selection
 * actions; never touches pixels.
 */
import { toolStore, useToolState, isPaintTool, isSelectionTool } from "../state/tools";
import { actions } from "../state/useEngine";

function Slider({
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
      <span className="w-14 text-[11px] text-muted">{label}</span>
      <input
        type="range"
        className="w-28"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
      />
      <span className="w-10 text-right text-[11px] tabular-nums text-muted">
        {fmt(value)}
      </span>
    </label>
  );
}

export function ToolOptions() {
  const { active, brush, feather } = useToolState();
  const paint = isPaintTool(active);
  const sel = isSelectionTool(active);

  return (
    <div className="flex items-center gap-4 border-b border-edge bg-panel px-3 py-1.5">
      <span className="text-[11px] font-semibold uppercase tracking-wider text-muted">
        {active.replace("-", " ")}
      </span>

      {paint && (
        <div className="flex items-center gap-4">
          <Slider
            label="Size"
            value={brush.size}
            min={1}
            max={512}
            step={1}
            fmt={(v) => `${Math.round(v)}px`}
            onChange={(v) => toolStore.setBrush({ size: v })}
          />
          <Slider
            label="Opacity"
            value={brush.opacity}
            min={0}
            max={1}
            step={0.01}
            fmt={(v) => `${Math.round(v * 100)}%`}
            onChange={(v) => toolStore.setBrush({ opacity: v })}
          />
          <Slider
            label="Hardness"
            value={brush.hardness}
            min={0}
            max={1}
            step={0.01}
            fmt={(v) => `${Math.round(v * 100)}%`}
            onChange={(v) => toolStore.setBrush({ hardness: v })}
          />
          <Slider
            label="Flow"
            value={brush.flow}
            min={0.01}
            max={1}
            step={0.01}
            fmt={(v) => `${Math.round(v * 100)}%`}
            onChange={(v) => toolStore.setBrush({ flow: v })}
          />
        </div>
      )}

      {sel && (
        <div className="flex items-center gap-4">
          <Slider
            label="Feather"
            value={feather}
            min={0}
            max={32}
            step={1}
            fmt={(v) => `${Math.round(v)}px`}
            onChange={(v) => toolStore.setFeather(v)}
          />
          <span className="text-[11px] text-muted">Shift add · Alt subtract</span>
          <button className="btn" onClick={() => actions.selectAll()}>
            Select all
          </button>
          <button className="btn" onClick={() => actions.clearSelection()}>
            Deselect
          </button>
        </div>
      )}

      {active === "move" && (
        <span className="text-[11px] text-muted">
          Drag to move the active layer · Space to pan
        </span>
      )}
      {active === "hand" && (
        <span className="text-[11px] text-muted">Drag to pan · scroll to zoom</span>
      )}
    </div>
  );
}
