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
