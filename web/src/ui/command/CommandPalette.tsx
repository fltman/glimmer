/**
 * Command palette (⌘K / Ctrl+K) — the canvas-first workspace's centerpiece.
 *
 * A single search box that runs ANY action by name: tools, adjustments, filters,
 * AI tools, panels, view toggles, edit + file commands. Because everything is
 * reachable here, the menus, tool rail, and panel dock can stay hidden on a
 * small laptop screen — you summon what you need by typing.
 *
 * Opened by ⌘K (wired in App). ↑/↓ to move, Enter to run, Esc to close.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { engine, useEngineSnapshot, useHistoryState, useViewExtras } from "../../state/useEngine";
import { exportPng } from "../../engine/export";
import { useWorkspace, workspaceStore } from "../../state/workspace";
import { buildCommands, fuzzyScore, type Command } from "./commandRegistry";

const GROUP_ORDER = ["Tools", "Adjustments", "Filters", "AI", "Panels", "View", "Edit", "File"];

async function exportPngDownload() {
  const blob = await exportPng(engine);
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = "ai-ps-export.png";
  a.click();
  URL.revokeObjectURL(url);
}

export function CommandPalette() {
  const ws = useWorkspace();
  const snap = useEngineSnapshot();
  const history = useHistoryState();
  const view = useViewExtras();
  const inputRef = useRef<HTMLInputElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);
  const [query, setQuery] = useState("");
  const [sel, setSel] = useState(0);

  // Rebuild commands whenever the palette opens or relevant state changes, so
  // toggles read the right "current" value and disabled flags are fresh.
  const commands = useMemo(
    () =>
      buildCommands({
        hasLayers: snap.layers.length > 0,
        canUndo: history.canUndo,
        canRedo: history.canRedo,
        rulersVisible: view.rulersVisible,
        gridVisible: view.grid.visible,
        snapEnabled: view.snapEnabled,
        leftRail: ws.leftRail,
        rightDockOpen: ws.rightDockOpen,
        onExport: () => void exportPngDownload(),
      }),
    [
      snap.layers.length,
      history.canUndo,
      history.canRedo,
      view.rulersVisible,
      view.grid.visible,
      view.snapEnabled,
      ws.leftRail,
      ws.rightDockOpen,
    ],
  );

  // Filtered + sorted results.
  const results = useMemo(() => {
    const q = query.trim();
    const scored: { cmd: Command; score: number; order: number }[] = [];
    commands.forEach((cmd, order) => {
      const s = fuzzyScore(`${cmd.title} ${cmd.keywords ?? ""}`, q);
      if (s !== null) scored.push({ cmd, score: s, order });
    });
    scored.sort((a, b) => a.score - b.score || a.order - b.order);
    // No query → keep registry order grouped; query → score order, capped.
    if (!q) return scored.sort((a, b) => a.order - b.order).map((x) => x.cmd);
    return scored.slice(0, 60).map((x) => x.cmd);
  }, [commands, query]);

  // Reset selection + focus when opened or query changes.
  useEffect(() => {
    if (ws.paletteOpen) {
      setQuery("");
      setSel(0);
      // Focus after paint.
      requestAnimationFrame(() => inputRef.current?.focus());
    }
  }, [ws.paletteOpen]);
  useEffect(() => setSel(0), [query]);

  // Keep the selected row in view.
  useEffect(() => {
    const el = listRef.current?.querySelector(`[data-idx="${sel}"]`);
    el?.scrollIntoView({ block: "nearest" });
  }, [sel]);

  if (!ws.paletteOpen) return null;

  const run = (cmd: Command | undefined) => {
    if (!cmd || cmd.enabled === false) return;
    workspaceStore.closePalette();
    // Defer so the palette unmounts before the action (e.g. focus changes).
    requestAnimationFrame(() => cmd.run());
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setSel((s) => Math.min(s + 1, results.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setSel((s) => Math.max(s - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      run(results[sel]);
    } else if (e.key === "Escape") {
      e.preventDefault();
      workspaceStore.closePalette();
    }
  };

  let lastGroup = "";

  return (
    <div
      className="fixed inset-0 z-[100] flex items-start justify-center bg-black/50 pt-[11vh]"
      onMouseDown={() => workspaceStore.closePalette()}
    >
      <div
        className="flex max-h-[72vh] w-[600px] max-w-[92vw] flex-col overflow-hidden rounded-xl border border-edge bg-panelraised shadow-2xl"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-2 border-b border-edge px-3.5 py-3">
          <span className="text-muted">⌘K</span>
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={onKeyDown}
            placeholder="Run a command — tool, adjustment, filter, AI, view…"
            className="min-w-0 flex-1 bg-transparent text-sm text-ink outline-none placeholder:text-muted"
            spellCheck={false}
            autoComplete="off"
          />
          <span className="shrink-0 text-[10px] text-muted">↑↓ · Enter · Esc</span>
        </div>

        <div ref={listRef} className="min-h-0 flex-1 overflow-y-auto py-1">
          {results.length === 0 ? (
            <div className="px-4 py-6 text-center text-xs text-muted">
              No commands match “{query}”.
            </div>
          ) : (
            results.map((cmd, i) => {
              const showGroup = !query.trim() && cmd.group !== lastGroup;
              if (showGroup) lastGroup = cmd.group;
              const disabled = cmd.enabled === false;
              return (
                <div key={cmd.id}>
                  {showGroup && (
                    <div className="px-3.5 pb-1 pt-2 text-[10px] font-semibold uppercase tracking-wider text-muted">
                      {cmd.group}
                    </div>
                  )}
                  <button
                    data-idx={i}
                    disabled={disabled}
                    onMouseEnter={() => setSel(i)}
                    onClick={() => run(cmd)}
                    className={`flex w-full items-center gap-3 px-3.5 py-1.5 text-left text-sm ${
                      disabled
                        ? "cursor-not-allowed text-muted/50"
                        : i === sel
                          ? "bg-accent/20 text-ink"
                          : "text-ink hover:bg-edge"
                    }`}
                  >
                    {query.trim() && (
                      <span className="w-16 shrink-0 truncate text-[10px] uppercase tracking-wider text-muted">
                        {cmd.group}
                      </span>
                    )}
                    <span className="min-w-0 flex-1 truncate">{cmd.title}</span>
                    {cmd.hint && (
                      <span className="shrink-0 rounded border border-edge px-1.5 py-0.5 text-[10px] text-muted">
                        {cmd.hint}
                      </span>
                    )}
                  </button>
                </div>
              );
            })
          )}
        </div>
      </div>
    </div>
  );
}
