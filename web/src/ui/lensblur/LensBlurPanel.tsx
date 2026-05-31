/**
 * LensBlurPanel — a floating control panel for the AI Lens Blur session
 * (depth-aware bokeh). It renders ONLY while a session is active
 * (engine.isLensBlurActive()), overlaying the top-center of the canvas.
 *
 * The depth map is estimated by the client-ML depth worker
 * (depth-anything-v2-small) the moment the session begins; the first run also
 * has to download the model, so `depthReady` can lag a moment behind. While the
 * worker runs we show a progress state; the sliders are disabled until depth is
 * ready (moving them would do nothing useful — the live GL preview composites
 * depth × params in-shader).
 *
 * The panel only:
 *   - shows the depth-loading / estimating progress,
 *   - sets Focus (the in-focus depth plane), Blur Amount, and Bokeh,
 *   - offers a "Show depth map" peek (engine.getDepthPreview → grayscale PNG),
 *   - offers Apply (engine.commitLensBlur → one undo step) and Cancel,
 * all through the engine action wrappers. React never touches pixels — every
 * slider drag calls engine.setLensBlurParams() and the engine re-renders the
 * preview itself.
 *
 * State is read reactively via useLensBlurState() (useSyncExternalStore over the
 * engine's subscribe), so the panel mounts/unmounts and the readiness/progress
 * indicators stay in sync with the engine without polling.
 *
 * Positioning: this panel is a fixed-position element (mounted via a portal in
 * LensBlurMenu — see Toolbar) that anchors itself top-center over the live
 * <canvas> element using its bounding rect, so it overlays the canvas region
 * (not the side rails/panels) without App.tsx having to mount it inside <main>.
 */
import { useEffect, useRef, useState } from "react";
import { actions, useLensBlurState } from "../../state/useEngine";

/** Track the on-screen rect of the editor canvas so the panel sits over it. */
function useCanvasRect(active: boolean): DOMRect | null {
  const [rect, setRect] = useState<DOMRect | null>(null);
  const rafRef = useRef<number | null>(null);

  useEffect(() => {
    if (!active) {
      setRect(null);
      return;
    }
    const canvas = document.querySelector("main canvas") as HTMLCanvasElement | null;
    if (!canvas) return;

    const measure = () => {
      setRect(canvas.getBoundingClientRect());
    };
    measure();

    // Re-measure on layout changes (window resize, panel splits, zoom). A
    // ResizeObserver on the canvas covers most cases; window resize covers the
    // rest (the canvas can move without resizing).
    const ro = new ResizeObserver(() => {
      if (rafRef.current != null) cancelAnimationFrame(rafRef.current);
      rafRef.current = requestAnimationFrame(measure);
    });
    ro.observe(canvas);
    window.addEventListener("resize", measure);
    window.addEventListener("scroll", measure, true);

    return () => {
      ro.disconnect();
      window.removeEventListener("resize", measure);
      window.removeEventListener("scroll", measure, true);
      if (rafRef.current != null) cancelAnimationFrame(rafRef.current);
    };
  }, [active]);

  return rect;
}

export function LensBlurPanel() {
  const { active, depthReady, params, status, error } = useLensBlurState();
  const [showDepth, setShowDepth] = useState(false);
  const [depthUrl, setDepthUrl] = useState<string | null>(null);
  const [depthLoading, setDepthLoading] = useState(false);
  const rect = useCanvasRect(active);

  // Fetch the depth preview PNG lazily when the user toggles "Show depth map"
  // on (and depth is ready). The object URL is revoked on cleanup / toggle-off.
  useEffect(() => {
    if (!active || !showDepth || !depthReady) {
      setDepthUrl((prev) => {
        if (prev) URL.revokeObjectURL(prev);
        return null;
      });
      return;
    }
    let live = true;
    setDepthLoading(true);
    void actions
      .getDepthPreview()
      .then((blob) => {
        if (!live) return;
        if (blob) {
          const url = URL.createObjectURL(blob);
          setDepthUrl(url);
        }
      })
      .finally(() => {
        if (live) setDepthLoading(false);
      });
    return () => {
      live = false;
    };
  }, [active, showDepth, depthReady]);

  // Revoke any outstanding depth object URL when the panel unmounts.
  useEffect(() => {
    return () => {
      setDepthUrl((prev) => {
        if (prev) URL.revokeObjectURL(prev);
        return null;
      });
    };
  }, []);

  if (!active) return null;

  // Anchor top-center over the canvas; fall back to viewport-centered if the
  // canvas rect isn't measured yet (e.g. the very first frame).
  const left = rect ? rect.left + rect.width / 2 : window.innerWidth / 2;
  const top = rect ? rect.top + 12 : 64;

  const focus = Math.round(params.focus * 100);
  const amount = Math.round(params.amount * 100);
  const bokeh = Math.round(params.bokeh * 100);

  return (
    <div
      className="fixed z-40 w-[340px] -translate-x-1/2 select-none rounded-lg border border-edge bg-panelraised/95 p-3 shadow-2xl backdrop-blur"
      style={{ left, top }}
      // Keep clicks/drags inside the panel from falling through to the canvas.
      onPointerDown={(e) => e.stopPropagation()}
    >
      <div className="mb-2 flex items-center justify-between">
        <span className="text-xs font-semibold tracking-tight text-ink">
          AI Lens Blur
        </span>
        <span className="text-[10px] text-muted">Enter to apply · Esc to cancel</span>
      </div>

      {error ? (
        <p className="mb-3 rounded-md bg-red-500/10 px-2 py-1.5 text-[11px] text-red-400">
          {error}
        </p>
      ) : !depthReady ? (
        <div className="mb-3 flex items-center gap-2 rounded-md bg-panel px-2 py-2 text-[11px] text-muted">
          <span className="inline-block h-3 w-3 animate-spin rounded-full border-2 border-accent border-t-transparent" />
          <span>{status ?? "Preparing depth model…"}</span>
        </div>
      ) : (
        <p className="mb-3 text-[11px] text-muted/80">
          Depth ready — drag the focal plane to choose what stays sharp.
        </p>
      )}

      <Slider
        label="Focus"
        title="The in-focus depth plane (0 = far, 100 = near)"
        value={focus}
        min={0}
        max={100}
        step={1}
        suffix="%"
        disabled={!depthReady}
        onChange={(v) => actions.setLensBlurParams({ focus: v / 100 })}
      />

      <Slider
        label="Blur"
        title="Maximum blur radius away from the focal plane"
        value={amount}
        min={0}
        max={100}
        step={1}
        suffix="%"
        disabled={!depthReady}
        onChange={(v) => actions.setLensBlurParams({ amount: v / 100 })}
      />

      <Slider
        label="Bokeh"
        title="Highlight bloom in the out-of-focus areas"
        value={bokeh}
        min={0}
        max={100}
        step={1}
        suffix="%"
        disabled={!depthReady}
        onChange={(v) => actions.setLensBlurParams({ bokeh: v / 100 })}
      />

      {/* Depth-map peek toggle + preview. */}
      <label
        className={`mt-2 flex items-center gap-2 text-[11px] ${
          depthReady ? "cursor-pointer text-muted hover:text-ink" : "cursor-not-allowed text-muted/50"
        }`}
      >
        <input
          type="checkbox"
          className="h-3 w-3 accent-accent"
          checked={showDepth}
          disabled={!depthReady}
          onChange={(e) => setShowDepth(e.target.checked)}
        />
        Show depth map
      </label>

      {showDepth && depthReady && (
        <div className="mt-2 overflow-hidden rounded-md border border-edge bg-black/40">
          {depthLoading || !depthUrl ? (
            <div className="flex h-24 items-center justify-center text-[10px] text-muted">
              Rendering depth…
            </div>
          ) : (
            <img
              src={depthUrl}
              alt="Depth map (near = bright)"
              className="block max-h-40 w-full object-contain"
              draggable={false}
            />
          )}
        </div>
      )}

      {/* Actions. */}
      <div className="mt-3 flex items-center gap-2">
        <div className="flex-1" />
        <button className="btn" onClick={() => actions.cancelLensBlur()}>
          Cancel
        </button>
        <button
          className="btn btn-accent"
          disabled={!depthReady}
          title={depthReady ? "Bake the blur into the layer" : "Waiting for the depth map…"}
          onClick={() => actions.commitLensBlur()}
        >
          Apply
        </button>
      </div>
    </div>
  );
}

/** A labeled slider row with a tabular numeric readout, matching the dark style. */
function Slider({
  label,
  title,
  value,
  min,
  max,
  step,
  suffix,
  disabled,
  onChange,
}: {
  label: string;
  title?: string;
  value: number;
  min: number;
  max: number;
  step: number;
  suffix?: string;
  disabled?: boolean;
  onChange: (v: number) => void;
}) {
  return (
    <div className="mb-1.5 flex items-center gap-2" title={title}>
      <span className="w-12 shrink-0 text-[11px] text-muted">{label}</span>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(Number(e.target.value))}
        className="h-1 flex-1 cursor-pointer accent-accent disabled:cursor-not-allowed disabled:opacity-40"
      />
      <span className="w-10 shrink-0 text-right text-[11px] tabular-nums text-ink">
        {value}
        {suffix}
      </span>
    </div>
  );
}
