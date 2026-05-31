/**
 * Navigator panel — a downscaled live thumbnail of the whole document with a
 * draggable viewport rectangle, plus zoom controls.
 *
 * React never touches pixels: the thumbnail comes from
 * `engine.getNavigatorThumbnail()` (a GPU readback the engine owns) and the
 * viewport rect comes from `engine.getViewportRectInDoc()` (doc-space). Dragging
 * the rect calls `engine.centerViewOnDoc()`; the zoom slider/buttons drive
 * `engine.zoomAt()` about the canvas center. Everything maps through doc space,
 * so it stays correct under view rotation: the engine reports the visible region
 * as a centered, possibly-rotated doc rectangle and we render it rotated about
 * its own center.
 *
 * The thumbnail is regenerated (throttled) whenever the document or the view
 * changes, and revoked promptly to avoid leaking object URLs.
 */
import { useCallbackRef } from "./useCallbackRef";
import { useEffect, useMemo, useRef, useState } from "react";
import { engine, useEngineSnapshot, useViewState } from "../../state/useEngine";

/** Longest-edge cap for the navigator thumbnail (doc → blob downscale). */
const THUMB_MAX_PX = 220;
/** Throttle window for thumbnail regeneration (ms). */
const REGEN_THROTTLE_MS = 220;

type Thumb = { url: string; width: number; height: number };

/** Centered, possibly-rotated doc-space viewport rectangle. */
type ViewportRect = {
  x: number;
  y: number;
  width: number;
  height: number;
  rotationDeg: number;
};

/**
 * Owns the throttled thumbnail lifecycle. Returns the latest decoded thumbnail
 * (object URL + size) or null. Regenerates when `signature` changes (doc/view).
 */
function useNavigatorThumbnail(signature: string): Thumb | null {
  const [thumb, setThumb] = useState<Thumb | null>(null);
  const pending = useRef(false);
  const queued = useRef(false);
  const lastRun = useRef(0);
  const aliveRef = useRef(true);
  const urlRef = useRef<string | null>(null);

  useEffect(() => {
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
      if (urlRef.current) {
        URL.revokeObjectURL(urlRef.current);
        urlRef.current = null;
      }
    };
  }, []);

  useEffect(() => {
    let timer: number | undefined;

    async function run() {
      if (pending.current) {
        queued.current = true;
        return;
      }
      pending.current = true;
      lastRun.current = Date.now();
      try {
        const res = await engine.getNavigatorThumbnail(THUMB_MAX_PX);
        if (!aliveRef.current) {
          // Component unmounted mid-flight — drop the blob.
          return;
        }
        if (res) {
          const url = URL.createObjectURL(res.blob);
          if (urlRef.current) URL.revokeObjectURL(urlRef.current);
          urlRef.current = url;
          setThumb({ url, width: res.width, height: res.height });
        } else {
          if (urlRef.current) URL.revokeObjectURL(urlRef.current);
          urlRef.current = null;
          setThumb(null);
        }
      } finally {
        pending.current = false;
        if (queued.current) {
          queued.current = false;
          // Trailing run to capture changes that arrived during the readback.
          timer = window.setTimeout(run, REGEN_THROTTLE_MS);
        }
      }
    }

    const since = Date.now() - lastRun.current;
    if (since >= REGEN_THROTTLE_MS) {
      run();
    } else {
      timer = window.setTimeout(run, REGEN_THROTTLE_MS - since);
    }

    return () => {
      if (timer) window.clearTimeout(timer);
    };
  }, [signature]);

  return thumb;
}

/**
 * The thumbnail + viewport-rect surface. Layout is doc-aspect; we map doc px →
 * thumbnail px with a single `k` factor (uniform, preserves aspect) and place a
 * rotated rect. Dragging recenters the view on the doc point under the cursor.
 */
function NavigatorMap({ thumb }: { thumb: Thumb | null }) {
  const snap = useEngineSnapshot();
  const view = useViewState(); // re-renders on zoom/rotate/pan
  const surfaceRef = useRef<HTMLDivElement | null>(null);
  const draggingRef = useRef(false);

  const docW = Math.max(1, snap.width);
  const docH = Math.max(1, snap.height);

  // doc px shown per thumbnail px (uniform). When no thumb yet, fall back to a
  // notional box so the rect still renders during the first readback.
  const boxW = thumb?.width ?? Math.round(THUMB_MAX_PX * Math.min(1, docW / docH));
  const boxH = thumb?.height ?? Math.round(THUMB_MAX_PX * Math.min(1, docH / docW));
  const k = boxW / docW; // thumbnail px per doc px (uniform with boxH/docH)

  const rect: ViewportRect = useMemo(
    () => engine.getViewportRectInDoc(),
    // view captures zoom/rotation; snap captures doc-size changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [view.zoom, view.rotationDeg, snap.width, snap.height, snap.activeLayerId],
  );

  // Center the view on the doc point under the pointer (clamped to the doc).
  const recenterFromEvent = useCallbackRef((clientX: number, clientY: number) => {
    const el = surfaceRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const localX = clientX - r.left;
    const localY = clientY - r.top;
    const docX = clamp(localX / k, 0, docW);
    const docY = clamp(localY / k, 0, docH);
    engine.centerViewOnDoc(docX, docY);
  });

  useEffect(() => {
    function onMove(e: PointerEvent) {
      if (!draggingRef.current) return;
      recenterFromEvent(e.clientX, e.clientY);
    }
    function onUp() {
      draggingRef.current = false;
    }
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
  }, [recenterFromEvent]);

  function onPointerDown(e: React.PointerEvent) {
    e.preventDefault();
    draggingRef.current = true;
    recenterFromEvent(e.clientX, e.clientY);
  }

  // Viewport rect in thumbnail px (centered + rotated about its own center).
  const rcx = (rect.x + rect.width / 2) * k;
  const rcy = (rect.y + rect.height / 2) * k;
  const rw = rect.width * k;
  const rh = rect.height * k;

  return (
    <div className="flex justify-center">
      <div
        ref={surfaceRef}
        className="relative cursor-move select-none overflow-hidden rounded border border-edge bg-[#0c0d0f]"
        style={{ width: boxW, height: boxH }}
        onPointerDown={onPointerDown}
        title="Drag to pan the view"
      >
        {/* Checkerboard backing so transparent docs read as transparent. */}
        <div
          className="absolute inset-0 opacity-60"
          style={{
            backgroundImage:
              "linear-gradient(45deg,#2a2b2f 25%,transparent 25%),linear-gradient(-45deg,#2a2b2f 25%,transparent 25%),linear-gradient(45deg,transparent 75%,#2a2b2f 75%),linear-gradient(-45deg,transparent 75%,#2a2b2f 75%)",
            backgroundSize: "12px 12px",
            backgroundPosition: "0 0,0 6px,6px -6px,-6px 0",
          }}
        />
        {thumb && (
          <img
            src={thumb.url}
            alt="Document thumbnail"
            draggable={false}
            className="pointer-events-none absolute inset-0 h-full w-full"
          />
        )}
        {/* Viewport rect: a centered box rotated about its own center. */}
        <div
          className="pointer-events-none absolute border-2 border-accent"
          style={{
            left: rcx - rw / 2,
            top: rcy - rh / 2,
            width: rw,
            height: rh,
            transform: `rotate(${rect.rotationDeg}deg)`,
            transformOrigin: "center center",
            boxShadow: "0 0 0 9999px rgba(0,0,0,0.28)",
          }}
        />
      </div>
    </div>
  );
}

/** Discrete zoom stops for the slider (log-ish, matches editor feel). */
const ZOOM_MIN = 0.02;
const ZOOM_MAX = 64;

function clamp(v: number, lo: number, hi: number) {
  return v < lo ? lo : v > hi ? hi : v;
}

/**
 * Zoom about the drawing-buffer center. We don't have a screen-anchor here, so
 * pass the canvas CSS center; the engine converts via dpr internally.
 */
function zoomToAbsolute(target: number) {
  const cur = engine.getZoom();
  const next = clamp(target, ZOOM_MIN, ZOOM_MAX);
  if (next === cur) return;
  const factor = next / cur;
  const c = engine.getViewRotationPivotCss();
  engine.zoomAt(factor, c.x, c.y);
}

function ZoomControls() {
  const view = useViewState();
  const pct = Math.round(view.zoom * 100);

  // Map zoom (log scale) → slider 0..1 and back for a usable range.
  const sliderPos = useMemo(() => {
    const t =
      (Math.log(view.zoom) - Math.log(ZOOM_MIN)) /
      (Math.log(ZOOM_MAX) - Math.log(ZOOM_MIN));
    return clamp(t, 0, 1);
  }, [view.zoom]);

  function onSlider(e: React.ChangeEvent<HTMLInputElement>) {
    const t = Number(e.target.value);
    const z = Math.exp(
      Math.log(ZOOM_MIN) + t * (Math.log(ZOOM_MAX) - Math.log(ZOOM_MIN)),
    );
    zoomToAbsolute(z);
  }

  return (
    <div className="mt-2 flex items-center gap-2">
      <button
        className="btn h-7 w-7 p-0 text-base leading-none"
        title="Zoom out"
        onClick={() => zoomToAbsolute(engine.getZoom() / 1.25)}
      >
        −
      </button>
      <input
        type="range"
        min={0}
        max={1}
        step={0.001}
        value={sliderPos}
        onChange={onSlider}
        className="flex-1"
        aria-label="Zoom"
      />
      <button
        className="btn h-7 w-7 p-0 text-base leading-none"
        title="Zoom in"
        onClick={() => zoomToAbsolute(engine.getZoom() * 1.25)}
      >
        +
      </button>
      <span className="w-12 select-none text-right text-xs tabular-nums text-muted">
        {pct}%
      </span>
    </div>
  );
}

/** The Navigator panel body (mounted inside the Toolbar popover). */
export function NavigatorPanel() {
  const snap = useEngineSnapshot();
  const view = useViewState();

  // Signature that changes whenever the visible composite could change. We key
  // off doc size + layer count + active layer + zoom + rotation. (Pixel-only
  // edits also bump the snapshot version via layers array identity below.)
  const signature = useMemo(() => {
    const layerSig = snap.layers
      .map((l) => `${l.id}:${l.visible}:${l.opacity}`)
      .join("|");
    return `${snap.width}x${snap.height}|${layerSig}|${snap.activeLayerId}|${view.zoom.toFixed(
      4,
    )}|${view.rotationDeg.toFixed(2)}`;
  }, [snap, view.zoom, view.rotationDeg]);

  const thumb = useNavigatorThumbnail(signature);
  const hasDoc = snap.layers.length > 0;

  return (
    <div className="w-[260px]">
      <div className="mb-2 flex items-center justify-between">
        <span className="text-[10px] font-semibold uppercase tracking-wider text-muted">
          Navigator
        </span>
        <span className="text-[10px] tabular-nums text-muted">
          {snap.width}×{snap.height}
        </span>
      </div>
      {hasDoc ? (
        <>
          <NavigatorMap thumb={thumb} />
          <ZoomControls />
        </>
      ) : (
        <div className="flex h-32 items-center justify-center rounded border border-dashed border-edge text-xs text-muted">
          Open an image
        </div>
      )}
    </div>
  );
}
