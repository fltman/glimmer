/**
 * LensBlurMenu — a single top-bar button that opens an AI Lens Blur session on
 * the active raster layer (engine.beginLensBlur). It mirrors the FiltersMenu /
 * LiquifyMenu raster-only gating: disabled unless the active layer is a raster
 * layer, since Lens Blur is a destructive depth-aware bokeh applied to pixels.
 *
 * Beginning a session kicks off the client-ML depth estimate immediately (the
 * first run also downloads the depth model, which can take a moment — the
 * floating <LensBlurPanel/> shows that progress). The button reflects an active
 * session by disabling itself (you can't begin a second session).
 *
 * This component ALSO owns the panel: because App.tsx must stay untouched and
 * the panel needs to float over the canvas, we render <LensBlurPanel/> through a
 * portal into document.body (the panel positions itself over the canvas via the
 * canvas bounding rect). The panel self-gates on engine.isLensBlurActive(), so
 * mounting it here unconditionally is safe — it renders nothing until a session
 * is active.
 */
import { createPortal } from "react-dom";
import { actions, useEngineSnapshot, useLensBlurState } from "../../state/useEngine";
import { LensBlurPanel } from "./LensBlurPanel";

export function LensBlurMenu() {
  const snap = useEngineSnapshot();
  const { active } = useLensBlurState();

  // Lens Blur warps pixels via a depth-aware gather, so it only applies to a
  // raster layer (same gating as Liquify / destructive filters).
  const activeLayer = snap.layers.find((l) => l.id === snap.activeLayerId) ?? null;
  const targetId = activeLayer && activeLayer.kind === "raster" ? activeLayer.id : null;
  const disabled = targetId === null || active;

  return (
    <>
      <button
        className="btn"
        disabled={disabled}
        title={
          active
            ? "An AI Lens Blur session is already active"
            : targetId === null
              ? "Select a raster layer to apply AI Lens Blur"
              : "AI Lens Blur — depth-aware bokeh (computes a depth map; first run loads the model)"
        }
        onClick={() => actions.beginLensBlur()}
      >
        AI Lens Blur…
      </button>

      {/* Floating panel over the canvas, mounted out-of-tree so it overlays the
          canvas without App.tsx needing to render it inside <main>. */}
      {createPortal(<LensBlurPanel />, document.body)}
    </>
  );
}
