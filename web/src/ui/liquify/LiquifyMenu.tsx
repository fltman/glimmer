/**
 * LiquifyMenu — a single top-bar button that opens a Liquify session on the
 * active raster layer (actions.beginLiquify). It mirrors the FiltersMenu's
 * raster-only gating: disabled unless the active layer is a raster layer, since
 * Liquify is a destructive pixel warp.
 *
 * Once a session begins, the floating <LiquifyPanel/> (mounted over the canvas
 * in App) takes over — this button just kicks it off. The button also reflects
 * the active session by disabling itself (you can't begin a second session).
 */
import { actions, useEngineSnapshot, useLiquifyState } from "../../state/useEngine";

export function LiquifyMenu() {
  const snap = useEngineSnapshot();
  const { active: liquifying } = useLiquifyState();

  // Liquify warps pixels, so it only applies to a raster layer.
  const activeLayer = snap.layers.find((l) => l.id === snap.activeLayerId) ?? null;
  const targetId = activeLayer && activeLayer.kind === "raster" ? activeLayer.id : null;
  const disabled = targetId === null || liquifying;

  return (
    <button
      className="btn"
      disabled={disabled}
      title={
        liquifying
          ? "A Liquify session is already active"
          : targetId === null
            ? "Select a raster layer to liquify"
            : "Liquify — warp pixels by dragging"
      }
      onClick={() => actions.beginLiquify()}
    >
      Liquify…
    </button>
  );
}
