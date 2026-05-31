/**
 * LiquifyPanel — a compact floating control panel for the modal Liquify warp
 * session. It is mounted once inside the canvas <main> and renders ONLY while a
 * session is active (engine.isLiquifying()), overlaying the top-center of the
 * canvas.
 *
 * The actual warping happens by DRAGGING on the canvas — the engine routes
 * pointer events internally while a session is active (and wires Enter/Esc to
 * commit/cancel). This panel only:
 *   - picks the warp MODE (Push / Bloat / Pucker / Twirl L / Twirl R / Reconstruct),
 *   - sets the brush Size + Pressure,
 *   - offers Restore All, Apply (commit → one undo step) and Cancel,
 * all through the engine action wrappers. React never touches pixels.
 *
 * State is read reactively via useLiquifyState() (useSyncExternalStore over the
 * engine's subscribe), so the panel mounts/unmounts and the active-mode
 * highlight stay in sync with the engine without polling.
 */
import { actions, useLiquifyState } from "../../state/useEngine";
import type { LiquifyMode } from "../../engine/LiquifyEngine";

/** The six warp modes in display order, with short labels for the button row. */
const MODES: { id: LiquifyMode; label: string; title: string }[] = [
  { id: "forward_warp", label: "Push", title: "Forward Warp — push pixels in the drag direction" },
  { id: "bloat", label: "Bloat", title: "Bloat — push pixels outward from the brush center" },
  { id: "pucker", label: "Pucker", title: "Pucker — pull pixels toward the brush center" },
  { id: "twirl_left", label: "Twirl L", title: "Twirl Left — rotate pixels counter-clockwise" },
  { id: "twirl_right", label: "Twirl R", title: "Twirl Right — rotate pixels clockwise" },
  { id: "reconstruct", label: "Restore", title: "Reconstruct — paint the warp back toward the original" },
];

export function LiquifyPanel() {
  const { active, mode, brush } = useLiquifyState();
  if (!active) return null;

  const size = Math.round(brush.size);
  const pressure = Math.round((brush.pressure ?? 1) * 100);

  return (
    <div
      className="absolute left-1/2 top-3 z-30 w-[360px] -translate-x-1/2 select-none rounded-lg border border-edge bg-panelraised/95 p-3 shadow-2xl backdrop-blur"
      // Stop pointer events from falling through to the canvas (which would warp
      // it). The canvas drag handler lives behind this panel.
      onPointerDown={(e) => e.stopPropagation()}
    >
      <div className="mb-2 flex items-center justify-between">
        <span className="text-xs font-semibold tracking-tight text-ink">Liquify</span>
        <span className="text-[10px] text-muted">Drag on the canvas to warp · Enter to apply · Esc to cancel</span>
      </div>

      {/* Mode buttons. */}
      <div className="mb-3 grid grid-cols-3 gap-1">
        {MODES.map((m) => {
          const on = mode === m.id;
          return (
            <button
              key={m.id}
              title={m.title}
              onClick={() => actions.setLiquifyMode(m.id)}
              className={`rounded-md px-2 py-1.5 text-[11px] font-medium transition-colors ${
                on
                  ? "bg-accent text-white"
                  : "bg-panel text-muted hover:bg-accent/20 hover:text-ink"
              }`}
            >
              {m.label}
            </button>
          );
        })}
      </div>

      {/* Brush size. */}
      <Slider
        label="Size"
        value={size}
        min={5}
        max={600}
        step={1}
        suffix="px"
        onChange={(v) => actions.setLiquifyBrush({ size: v })}
      />

      {/* Brush pressure. */}
      <Slider
        label="Pressure"
        value={pressure}
        min={1}
        max={100}
        step={1}
        suffix="%"
        onChange={(v) => actions.setLiquifyBrush({ pressure: v / 100 })}
      />

      {/* Actions. */}
      <div className="mt-3 flex items-center gap-2">
        <button
          className="btn"
          title="Relax the whole warp back toward the original"
          onClick={() => actions.liquifyReconstructAll()}
        >
          Restore All
        </button>
        <div className="flex-1" />
        <button className="btn" onClick={() => actions.cancelLiquify()}>
          Cancel
        </button>
        <button className="btn btn-accent" onClick={() => actions.commitLiquify()}>
          Apply
        </button>
      </div>
    </div>
  );
}

/** A labeled slider row with a tabular numeric readout, matching the dark style. */
function Slider({
  label,
  value,
  min,
  max,
  step,
  suffix,
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  suffix?: string;
  onChange: (v: number) => void;
}) {
  return (
    <div className="mb-1.5 flex items-center gap-2">
      <span className="w-16 shrink-0 text-[11px] text-muted">{label}</span>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        className="h-1 flex-1 cursor-pointer accent-accent"
      />
      <span className="w-12 shrink-0 text-right text-[11px] tabular-nums text-ink">
        {value}
        {suffix}
      </span>
    </div>
  );
}
