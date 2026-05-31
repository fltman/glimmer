/**
 * FileMenu — a Photoshop-style "File" menu dropdown for project I/O + export.
 *
 * Entries:
 *   - New              : clear the document (confirm if there are layers).
 *   - Open Project…    : pick an .aips file → engine.loadProject(file).
 *   - Save Project     : engine.saveProject() → download ai-ps-project.aips.
 *   - Export As…       : open the ExportDialog (PNG / JPEG / WebP).
 *
 * Self-contained controller: it owns the menu open/close state, the hidden
 * file input for Open, and the Export dialog. App just mounts <FileMenu/> in
 * the top bar.
 *
 * All project/image work routes through the engine (saveProject/loadProject/
 * exportImage); the menu never touches pixels.
 */
import { useEffect, useRef, useState } from "react";
import { engine, actions, useEngineSnapshot } from "../../state/useEngine";
import { ExportDialog } from "./ExportDialog";

export function FileMenu() {
  const snap = useEngineSnapshot();
  const [menuOpen, setMenuOpen] = useState(false);
  const [exportOpen, setExportOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const openInputRef = useRef<HTMLInputElement | null>(null);

  const hasLayers = snap.layers.length > 0;

  // Close the dropdown on outside click / Escape.
  useEffect(() => {
    if (!menuOpen) return;
    function onDown(e: MouseEvent) {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) {
        setMenuOpen(false);
      }
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setMenuOpen(false);
    }
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [menuOpen]);

  function onNew() {
    setMenuOpen(false);
    if (
      hasLayers &&
      !window.confirm("Start a new document? Unsaved changes will be lost.")
    ) {
      return;
    }
    // Clear via the engine's deserialize-reset path: load an empty project.
    void engine.loadProject(
      JSON.stringify({
        magic: "aips",
        version: 1,
        width: snap.width,
        height: snap.height,
        activeLayerId: null,
        rootOrder: [],
        nodes: [],
      }),
    );
  }

  async function onSave() {
    setMenuOpen(false);
    const blob = await actions.saveProject();
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "ai-ps-project.aips";
    a.click();
    URL.revokeObjectURL(url);
  }

  async function onOpenFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    await actions.loadProject(file);
  }

  function startExport() {
    setMenuOpen(false);
    setExportOpen(true);
  }

  return (
    <div className="relative" ref={rootRef}>
      <button
        className="btn"
        title="File"
        onClick={() => setMenuOpen((o) => !o)}
      >
        File
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

      {menuOpen && (
        <div className="absolute left-0 top-full z-40 mt-1 w-48 overflow-hidden rounded-md border border-edge bg-panelraised py-1 shadow-2xl">
          <MenuItem onClick={onNew}>New</MenuItem>
          <MenuItem onClick={() => openInputRef.current?.click()}>
            Open Project…
          </MenuItem>
          <div className="my-1 h-px bg-edge" />
          <MenuItem onClick={onSave}>Save Project</MenuItem>
          <MenuItem onClick={startExport} disabled={!hasLayers}>
            Export As…
          </MenuItem>
        </div>
      )}

      {/* Hidden file input for Open Project. */}
      <input
        ref={openInputRef}
        type="file"
        accept=".aips,application/json"
        className="hidden"
        onChange={onOpenFile}
      />

      {exportOpen && (
        <ExportDialog
          width={snap.width}
          height={snap.height}
          onClose={() => setExportOpen(false)}
        />
      )}
    </div>
  );
}

function MenuItem({
  onClick,
  disabled,
  children,
}: {
  onClick: () => void;
  disabled?: boolean;
  children: React.ReactNode;
}) {
  return (
    <button
      className="block w-full px-3 py-1.5 text-left text-xs text-ink transition-colors hover:bg-accent/20 disabled:cursor-not-allowed disabled:text-muted disabled:opacity-50 disabled:hover:bg-transparent"
      disabled={disabled}
      onClick={onClick}
    >
      {children}
    </button>
  );
}
