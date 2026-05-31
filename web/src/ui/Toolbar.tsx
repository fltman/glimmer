/**
 * Top bar: open image, fit, live zoom %, export PNG. All actions route through
 * the engine; React never reads pixels.
 */
import { useEffect, useRef, useState } from "react";
import {
  engine,
  actions,
  useEngineSnapshot,
  useHistoryState,
} from "../state/useEngine";
import { exportPng } from "../engine/export";
import { ADJUSTMENTS, ADJUSTMENT_ORDER } from "../engine/adjustments";
import { FiltersMenu } from "./filters";
import { SelectMenu } from "./select";

/**
 * Image ▸ Adjustments dropdown — Photoshop's `Image > Adjustments` menu.
 * Data-driven from the adjustment registry; picking an entry inserts a
 * non-destructive adjustment layer (one undo step) whose properties then open
 * in the right-side Adjustments panel.
 */
function ImageMenu({ disabled }: { disabled: boolean }) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    function onDown(e: MouseEvent) {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div className="relative" ref={rootRef}>
      <button
        className="btn"
        disabled={disabled}
        title={disabled ? "Open an image first" : "Image ▸ Adjustments"}
        onClick={() => setOpen((o) => !o)}
      >
        Image
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

      {open && !disabled && (
        <div className="absolute left-0 top-full z-40 mt-1 w-56 overflow-hidden rounded-md border border-edge bg-panelraised py-1 shadow-2xl">
          <div className="px-3 py-1 text-[10px] font-semibold uppercase tracking-wider text-muted">
            Adjustments
          </div>
          <div className="max-h-80 overflow-y-auto">
            {ADJUSTMENT_ORDER.map((type) => (
              <button
                key={type}
                className="block w-full px-3 py-1.5 text-left text-xs text-ink transition-colors hover:bg-accent/20"
                onClick={() => {
                  actions.addAdjustmentLayer(type);
                  setOpen(false);
                }}
              >
                {ADJUSTMENTS[type].label}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

export function Toolbar() {
  const snap = useEngineSnapshot();
  const history = useHistoryState();
  const fileRef = useRef<HTMLInputElement | null>(null);
  const [zoom, setZoom] = useState(100);

  // Poll the engine zoom for the live readout (cheap; engine owns the value).
  useEffect(() => {
    const id = setInterval(
      () => setZoom(Math.round(engine.getZoom() * 100)),
      120,
    );
    return () => clearInterval(id);
  }, []);

  async function onOpen(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    await engine.loadImageLayer(file, file.name.replace(/\.[^.]+$/, ""));
    e.target.value = "";
  }

  async function onExport() {
    const blob = await exportPng(engine);
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "ai-ps-export.png";
    a.click();
    URL.revokeObjectURL(url);
  }

  const hasLayers = snap.layers.length > 0;

  return (
    <div className="flex items-center gap-2 border-b border-edge bg-panel px-3 py-2">
      <div className="mr-2 flex items-center gap-2">
        <div className="h-5 w-5 rounded bg-gradient-to-br from-accent to-fuchsia-500" />
        <span className="text-sm font-semibold tracking-tight">ai-ps</span>
      </div>

      <button className="btn" onClick={() => fileRef.current?.click()}>
        Open image
      </button>
      <input
        ref={fileRef}
        type="file"
        accept="image/*"
        className="hidden"
        onChange={onOpen}
      />

      <button className="btn" onClick={() => actions.fit()} disabled={!hasLayers}>
        Fit
      </button>

      <div className="mx-1 h-5 w-px bg-edge" />

      {/* Photoshop-style menus */}
      <ImageMenu disabled={!hasLayers} />
      <FiltersMenu />
      <SelectMenu />

      <div className="mx-1 h-5 w-px bg-edge" />

      <button
        className="btn"
        onClick={() => actions.undo()}
        disabled={!history.canUndo}
        title="Undo (⌘Z)"
      >
        ↶ Undo
      </button>
      <button
        className="btn"
        onClick={() => actions.redo()}
        disabled={!history.canRedo}
        title="Redo (⇧⌘Z)"
      >
        ↷ Redo
      </button>

      <div className="ml-1 select-none rounded-md border border-edge bg-panelraised px-2 py-1 text-xs tabular-nums text-muted">
        {zoom}%
      </div>

      <div className="flex-1" />

      <button className="btn btn-accent" onClick={onExport} disabled={!hasLayers}>
        Export PNG
      </button>
    </div>
  );
}
