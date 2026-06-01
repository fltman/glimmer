/**
 * Top bar: open image, fit, live zoom %, export PNG. All actions route through
 * the engine; React never reads pixels.
 */
import { useEffect, useRef, useState } from "react";
import { Logo } from "./Logo";
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
import { FileMenu } from "./file";
import { LiquifyMenu } from "./liquify";
import { LensBlurMenu } from "./lensblur";
import {
  ContentAwareFillItem,
  ContentAwareFillModal,
} from "../ai/contentAware";
import { NavigatorButton } from "./navigator/NavigatorButton";
import { ViewControls } from "./navigator/ViewControls";
import { AccountWidget } from "./account/AccountWidget";

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

/**
 * Edit menu — host for selection-driven AI edits. Currently a single entry,
 * Content-Aware Fill, which removes the selected content and reconstructs the
 * background (inpaint mode:"remove") on a new layer. The item self-gates on a
 * non-empty selection + active raster layer; the modal (rendered at the menu
 * root) owns the job lifecycle and progress.
 */
function EditMenu() {
  const [open, setOpen] = useState(false);
  const [fillOpen, setFillOpen] = useState(false);
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
        title="Edit ▸ Content-Aware Fill"
        onClick={() => setOpen((o) => !o)}
      >
        Edit
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

      {open && (
        <div className="absolute left-0 top-full z-40 mt-1 w-56 overflow-hidden rounded-md border border-edge bg-panelraised py-1 shadow-2xl">
          <ContentAwareFillItem
            onPick={() => {
              setFillOpen(true);
              setOpen(false);
            }}
          />
        </div>
      )}

      {fillOpen && (
        <ContentAwareFillModal onClose={() => setFillOpen(false)} />
      )}
    </div>
  );
}

export function Toolbar() {
  const snap = useEngineSnapshot();
  const history = useHistoryState();
  /** Open image as a NEW document (a new tab). */
  const fileRef = useRef<HTMLInputElement | null>(null);
  /** Place an image INTO the current document (legacy single-doc behaviour). */
  const placeRef = useRef<HTMLInputElement | null>(null);
  const [zoom, setZoom] = useState(100);

  // Poll the engine zoom for the live readout (cheap; engine owns the value).
  useEffect(() => {
    const id = setInterval(
      () => setZoom(Math.round(engine.getZoom() * 100)),
      120,
    );
    return () => clearInterval(id);
  }, []);

  /** Open image as a NEW document (a new tab). */
  async function onOpen(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    await actions.openImageAsDocument(file, file.name.replace(/\.[^.]+$/, ""));
    e.target.value = "";
  }

  /** Place an image as a new layer INTO the current document (single-doc path). */
  async function onPlace(e: React.ChangeEvent<HTMLInputElement>) {
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
      <div className="mr-2 shrink-0">
        <Logo size="md" />
      </div>

      <button
        className="btn"
        onClick={() => fileRef.current?.click()}
        title="Open an image as a new document (a new tab)"
      >
        Open image
      </button>
      <input
        ref={fileRef}
        type="file"
        accept="image/*"
        className="hidden"
        onChange={onOpen}
      />

      <button
        className="btn"
        onClick={() => placeRef.current?.click()}
        disabled={!hasLayers}
        title="Place an image as a new layer in the current document"
      >
        Place
      </button>
      <input
        ref={placeRef}
        type="file"
        accept="image/*"
        className="hidden"
        onChange={onPlace}
      />

      <button className="btn" onClick={() => actions.fit()} disabled={!hasLayers}>
        Fit
      </button>

      <div className="mx-1 h-5 w-px bg-edge" />

      {/* Photoshop-style menus */}
      <FileMenu />
      <EditMenu />
      <ImageMenu disabled={!hasLayers} />
      <FiltersMenu />
      <LiquifyMenu />
      <LensBlurMenu />
      <SelectMenu />

      <div className="mx-1 h-5 w-px bg-edge" />

      <button
        className="btn px-2"
        onClick={() => actions.undo()}
        disabled={!history.canUndo}
        title="Undo (⌘Z)"
        aria-label="Undo"
      >
        ↶
      </button>
      <button
        className="btn px-2"
        onClick={() => actions.redo()}
        disabled={!history.canRedo}
        title="Redo (⇧⌘Z)"
        aria-label="Redo"
      >
        ↷
      </button>

      <div className="ml-1 select-none rounded-md border border-edge bg-panelraised px-2 py-1 text-xs tabular-nums text-muted">
        {zoom}%
      </div>

      <div className="mx-1 h-5 w-px bg-edge" />

      {/* Rotate-view controls + Navigator (overview/pan). */}
      <ViewControls />
      <NavigatorButton disabled={!hasLayers} />

      <div className="flex-1" />

      {/* Credit meter + account popover (live balance, dev top-up, usage). */}
      <AccountWidget />

      <button className="btn btn-accent" onClick={onExport} disabled={!hasLayers}>
        Export PNG
      </button>
    </div>
  );
}
