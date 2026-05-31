/**
 * SelectMenu — a Photoshop-style "Select" menu dropdown for the top bar.
 *
 * Items:
 *   All (⌘A)        → actions.selectAll()
 *   Deselect (⌘D)   → actions.clearSelection()
 *   Inverse (⇧⌘I)   → engine.invertSelection()
 *   Feather…        → PxPopover → engine.featherSelection(px)
 *   Expand…         → PxPopover → engine.expandSelection(px)
 *   Contract…       → PxPopover → engine.contractSelection(px)
 *   Select Subject ★ → client RMBG matte → engine.setSelectionFromMask(...)
 *
 * Self-contained controller: owns the menu open/close state, which inline
 * popover (if any) is showing, and the Select-Subject progress/error state.
 * App just mounts <SelectMenu/>. React never touches pixels — every action
 * routes through the engine.
 *
 * Select Subject runs entirely client-side: it exports the active raster
 * layer's pixels (as a doc-sized PNG via engine.exportLayerRegionPNG), feeds
 * them to removeBackgroundClient (RMBG-1.4 in a Web Worker, WebGPU→wasm), then
 * turns the cutout's matte alpha into a marching-ants selection. The first run
 * is slow while the model downloads/initializes — progress is surfaced inline.
 */
import { useEffect, useRef, useState } from "react";
import { engine, actions, useEngineSnapshot } from "../../state/useEngine";
import {
  removeBackgroundClient,
  type RmbgProgress,
} from "../../ai/clientProviders/rmbgClient";
import { PxPopover } from "./PxPopover";

type PopoverKind = "feather" | "expand" | "contract" | null;

const POPOVER_META: Record<
  Exclude<PopoverKind, null>,
  { title: string; label: string; min: number; max: number; initial: number }
> = {
  feather: { title: "Feather selection", label: "Radius", min: 0, max: 250, initial: 4 },
  expand: { title: "Expand selection", label: "Amount", min: 1, max: 32, initial: 4 },
  contract: { title: "Contract selection", label: "Amount", min: 1, max: 32, initial: 4 },
};

/** Decode a PNG blob and return its alpha channel as a doc-sized ImageData. */
async function blobToImageData(
  blob: Blob,
  width: number,
  height: number,
): Promise<ImageData> {
  const bitmap = await createImageBitmap(blob, {
    premultiplyAlpha: "none",
    colorSpaceConversion: "none",
  });
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d", { willReadFrequently: true })!;
  // The exported region is already doc-sized, but draw to the exact rect to be
  // safe (setSelectionFromMask ignores out-of-size inputs).
  ctx.drawImage(bitmap, 0, 0, width, height);
  bitmap.close();
  return ctx.getImageData(0, 0, width, height);
}

export function SelectMenu() {
  const snap = useEngineSnapshot();
  const [menuOpen, setMenuOpen] = useState(false);
  const [popover, setPopover] = useState<PopoverKind>(null);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<RmbgProgress | null>(null);
  const [error, setError] = useState<string | null>(null);
  const rootRef = useRef<HTMLDivElement | null>(null);

  const hasLayers = snap.layers.length > 0;
  const active = snap.layers.find((l) => l.id === snap.activeLayerId) ?? null;
  const activeRasterId = active && active.kind === "raster" ? active.id : null;
  const disabled = !hasLayers;

  // Close the dropdown on outside click / Escape (unless a popover is open,
  // which manages its own dismissal and shouldn't close the whole menu).
  useEffect(() => {
    if (!menuOpen) return;
    function onDown(e: MouseEvent) {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) {
        setMenuOpen(false);
        setPopover(null);
      }
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape" && !popover) setMenuOpen(false);
    }
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [menuOpen, popover]);

  function closeMenu() {
    setMenuOpen(false);
    setPopover(null);
  }

  function runPopover(kind: Exclude<PopoverKind, null>, px: number) {
    if (kind === "feather") engine.featherSelection(px);
    else if (kind === "expand") engine.expandSelection(px);
    else engine.contractSelection(px);
    closeMenu();
  }

  async function selectSubject() {
    if (activeRasterId === null) return;
    setError(null);
    setBusy(true);
    setProgress({ stage: "loading_model" });
    try {
      const w = snap.width;
      const h = snap.height;
      // Export the active layer composited into the full document rect so the
      // matte we get back is already document-sized (RMBG sees the layer where
      // it actually sits on the canvas).
      const png = await engine.exportLayerRegionPNG(activeRasterId, {
        x: 0,
        y: 0,
        width: w,
        height: h,
      });
      const { cutout } = await removeBackgroundClient(png, (p) =>
        setProgress(p),
      );
      // The cutout is a doc-sized RGBA PNG whose alpha is the subject matte.
      const matte = await blobToImageData(cutout, w, h);
      engine.setSelectionFromMask(matte);
      closeMenu();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Select Subject failed.");
    } finally {
      setBusy(false);
      setProgress(null);
    }
  }

  const progressText = progress
    ? progress.stage === "loading_model"
      ? `Loading model${
          progress.progress != null
            ? ` ${Math.round(progress.progress * 100)}%`
            : "…"
        }`
      : "Detecting subject…"
    : "Working…";

  const itemCls =
    "flex w-full items-center justify-between gap-3 px-3 py-1.5 text-left text-xs text-ink transition-colors hover:bg-accent/20 disabled:cursor-not-allowed disabled:text-muted disabled:hover:bg-transparent";
  const kbdCls = "text-[10px] tabular-nums text-muted";

  return (
    <div className="relative" ref={rootRef}>
      <button
        className="btn"
        disabled={disabled}
        title={disabled ? "Open an image first" : "Select"}
        onClick={() => setMenuOpen((o) => !o)}
      >
        Select
        <svg
          width="9"
          height="9"
          viewBox="0 0 12 12"
          className="opacity-70"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
        >
          <path d="M2.5 4.5 6 8l3.5-3.5" />
        </svg>
      </button>

      {menuOpen && !disabled && (
        <div className="absolute left-0 top-full z-40 mt-1 w-56 rounded-md border border-edge bg-panelraised py-1 shadow-2xl">
          <button
            className={itemCls}
            onClick={() => {
              actions.selectAll();
              closeMenu();
            }}
          >
            <span>All</span>
            <span className={kbdCls}>⌘A</span>
          </button>
          <button
            className={itemCls}
            onClick={() => {
              actions.clearSelection();
              closeMenu();
            }}
          >
            <span>Deselect</span>
            <span className={kbdCls}>⌘D</span>
          </button>
          <button
            className={itemCls}
            onClick={() => {
              engine.invertSelection();
              closeMenu();
            }}
          >
            <span>Inverse</span>
            <span className={kbdCls}>⇧⌘I</span>
          </button>

          <div className="my-1 h-px bg-edge" />

          {(["feather", "expand", "contract"] as const).map((kind) => (
            <div key={kind} className="relative">
              <button
                className={itemCls}
                onClick={() =>
                  setPopover((p) => (p === kind ? null : kind))
                }
              >
                <span>
                  {kind === "feather"
                    ? "Feather…"
                    : kind === "expand"
                      ? "Expand…"
                      : "Contract…"}
                </span>
                <svg
                  width="8"
                  height="8"
                  viewBox="0 0 12 12"
                  className="opacity-60"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                >
                  <path d="M4.5 2.5 8 6l-3.5 3.5" />
                </svg>
              </button>
              {popover === kind && (
                <PxPopover
                  title={POPOVER_META[kind].title}
                  label={POPOVER_META[kind].label}
                  initial={POPOVER_META[kind].initial}
                  min={POPOVER_META[kind].min}
                  max={POPOVER_META[kind].max}
                  onApply={(px) => runPopover(kind, px)}
                  onClose={() => setPopover(null)}
                />
              )}
            </div>
          ))}

          <div className="my-1 h-px bg-edge" />

          <button
            className={itemCls}
            disabled={activeRasterId === null || busy}
            title={
              activeRasterId === null
                ? "Select a raster layer first"
                : "Auto-select the subject (runs locally)"
            }
            onClick={selectSubject}
          >
            <span className="flex items-center gap-1.5">
              <span className="text-accent">★</span>
              Select Subject
            </span>
            {busy && (
              <span className="h-3 w-3 animate-spin rounded-full border border-edge border-t-accent" />
            )}
          </button>

          {(busy || error) && (
            <div className="mt-1 border-t border-edge px-3 pb-1 pt-2">
              {busy && (
                <div className="text-[10px] leading-snug text-muted">
                  {progressText}
                  <div className="mt-1 italic opacity-80">
                    First run downloads the model — this can take a few seconds.
                  </div>
                </div>
              )}
              {error && (
                <div className="text-[10px] leading-snug text-red-400">
                  {error}
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
