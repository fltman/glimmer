/**
 * Rotate-view controls for the Toolbar: rotate left/right by 15°, an editable
 * numeric angle, and a "reset view" (rotation = 0 + fit). All actions route
 * through the engine (`rotateView` / `setViewRotation` / `resetView`); the live
 * angle comes from the reactive view state. The engine handles every screen↔doc
 * mapping centrally, so overlays/tools stay correct as the angle changes.
 */
import { useEffect, useRef, useState } from "react";
import { engine, useViewState } from "../../state/useEngine";

/** Snap rounding so repeated 15° steps don't drift into floats on the readout. */
function roundAngle(deg: number): number {
  return Math.round(deg * 10) / 10;
}

function AngleField() {
  const view = useViewState();
  const [text, setText] = useState("0");
  const editingRef = useRef(false);

  // Keep the field in sync with the engine unless the user is editing it.
  useEffect(() => {
    if (!editingRef.current) {
      setText(String(roundAngle(view.rotationDeg)));
    }
  }, [view.rotationDeg]);

  function commit() {
    editingRef.current = false;
    const n = Number(text);
    if (Number.isFinite(n)) {
      engine.setViewRotation(n);
    } else {
      setText(String(roundAngle(engine.getViewRotation())));
    }
  }

  return (
    <input
      type="text"
      inputMode="numeric"
      value={text}
      onFocus={() => {
        editingRef.current = true;
      }}
      onChange={(e) => setText(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === "Enter") (e.target as HTMLInputElement).blur();
        if (e.key === "Escape") {
          editingRef.current = false;
          setText(String(roundAngle(engine.getViewRotation())));
          (e.target as HTMLInputElement).blur();
        }
      }}
      title="View rotation (degrees)"
      aria-label="View rotation in degrees"
      className="w-12 rounded border border-edge bg-panelraised px-1 py-1 text-center text-xs tabular-nums text-ink outline-none focus:border-accent"
    />
  );
}

export function ViewControls() {
  return (
    <div className="flex items-center gap-1">
      <button
        className="btn h-7 w-7 p-0"
        title="Rotate view 15° counter-clockwise"
        onClick={() => engine.rotateView(-15)}
      >
        {/* rotate-left glyph */}
        <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4">
          <path d="M4 4.5h4.5A3.5 3.5 0 0 1 12 8" strokeLinecap="round" />
          <path d="M4 4.5 6.2 2.3M4 4.5 6.2 6.7" strokeLinecap="round" strokeLinejoin="round" />
          <path d="M12 8a4 4 0 1 1-8 0" strokeLinecap="round" opacity="0.45" />
        </svg>
      </button>

      <AngleField />
      <span className="-ml-0.5 select-none text-xs text-muted">°</span>

      <button
        className="btn h-7 w-7 p-0"
        title="Rotate view 15° clockwise"
        onClick={() => engine.rotateView(15)}
      >
        {/* rotate-right glyph */}
        <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4">
          <path d="M12 4.5H7.5A3.5 3.5 0 0 0 4 8" strokeLinecap="round" />
          <path d="M12 4.5 9.8 2.3M12 4.5 9.8 6.7" strokeLinecap="round" strokeLinejoin="round" />
          <path d="M4 8a4 4 0 1 0 8 0" strokeLinecap="round" opacity="0.45" />
        </svg>
      </button>

      <button
        className="btn ml-0.5"
        title="Reset view (rotation 0 + fit)"
        onClick={() => engine.resetView()}
      >
        Reset
      </button>
    </div>
  );
}
