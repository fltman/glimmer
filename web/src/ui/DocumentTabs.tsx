/**
 * DocumentTabs — the multi-document tab strip.
 *
 * A horizontal row of tabs (one per open document) plus a "+" that opens the
 * New Document dialog. Each tab shows the document name + its pixel dimensions,
 * highlights the active document, and has a close "x". The strip reads the
 * documents snapshot via the engine's SEPARATE doc-list subscribable
 * (useDocuments), so it only re-renders when the tab set / active doc changes —
 * never on a pixel edit.
 *
 * All actions route through the multi-document engine API:
 *   - click a tab  → actions.switchDocument(id)
 *   - click "x"    → actions.closeDocument(id) (engine switches to a neighbor and
 *                    replaces the last doc with a fresh blank one, so there is
 *                    always ≥1 document — the canvas is never unmounted).
 *   - click "+"    → open the NewDocumentDialog.
 *
 * Mounted ABOVE <CanvasHost/> inside <main> (see App.tsx). It must NOT wrap or
 * replace CanvasHost — the <canvas> stays mounted once for the lifetime of the
 * GL context.
 */
import { useState } from "react";
import { actions, useDocuments } from "../state/useEngine";
import { NewDocumentDialog } from "./NewDocumentDialog";

export function DocumentTabs() {
  const { documents, activeDocId } = useDocuments();
  const [newOpen, setNewOpen] = useState(false);

  // A single empty "Untitled" document is the boot state — still show its tab so
  // the strip + the "+" affordance are always present (and the tab bar height is
  // stable, never collapsing the canvas).
  return (
    <div className="flex h-9 shrink-0 items-stretch gap-px overflow-x-auto border-b border-edge bg-panel">
      {documents.map((d) => (
        <DocumentTab
          key={d.id}
          id={d.id}
          name={d.name}
          width={d.width}
          height={d.height}
          active={d.active || d.id === activeDocId}
          // Don't allow closing the very last tab via UI confusion — the engine
          // handles it (replaces with a blank doc), but disabling avoids the
          // jarring "close then a new blank appears" flash for the lone tab.
          canClose={documents.length > 1}
        />
      ))}

      <button
        className="flex w-9 shrink-0 items-center justify-center text-lg leading-none text-muted transition-colors hover:bg-accent/15 hover:text-ink"
        title="New document"
        onClick={() => setNewOpen(true)}
      >
        +
      </button>

      {newOpen && <NewDocumentDialog onClose={() => setNewOpen(false)} />}
    </div>
  );
}

function DocumentTab({
  id,
  name,
  width,
  height,
  active,
  canClose,
}: {
  id: string;
  name: string;
  width: number;
  height: number;
  active: boolean;
  canClose: boolean;
}) {
  function onClose(e: React.MouseEvent) {
    // Don't let the close click also select the tab.
    e.stopPropagation();
    actions.closeDocument(id);
  }

  return (
    <div
      role="tab"
      aria-selected={active}
      title={`${name} · ${width} × ${height} px`}
      onClick={() => {
        if (!active) actions.switchDocument(id);
      }}
      // Middle-click closes (matches browser-tab convention).
      onAuxClick={(e) => {
        if (e.button === 1 && canClose) {
          e.preventDefault();
          actions.closeDocument(id);
        }
      }}
      className={`group flex min-w-0 max-w-52 shrink-0 cursor-pointer select-none items-center gap-2 border-b-2 px-3 transition-colors ${
        active
          ? "border-accent bg-panelraised text-ink"
          : "border-transparent text-muted hover:bg-panelraised/60 hover:text-ink"
      }`}
    >
      <span className="flex min-w-0 flex-col leading-tight">
        <span className="truncate text-xs font-medium">{name}</span>
        <span className="text-[10px] tabular-nums text-muted">
          {width} × {height}
        </span>
      </span>

      <button
        className={`-mr-1 flex h-4 w-4 shrink-0 items-center justify-center rounded text-xs leading-none transition-colors ${
          canClose
            ? "text-muted opacity-0 hover:bg-edge hover:text-ink group-hover:opacity-100"
            : "cursor-not-allowed text-muted/30"
        } ${active ? "opacity-100" : ""}`}
        title={canClose ? "Close document" : "Can't close the only document"}
        disabled={!canClose}
        onClick={onClose}
      >
        ×
      </button>
    </div>
  );
}
