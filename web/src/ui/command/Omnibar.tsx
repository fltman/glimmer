/**
 * Omnibar — the AI-first workspace's single point of entry.
 *
 * One always-present floating bar over a full-screen canvas. Type:
 *  - a free-form instruction ("make the sky a warm sunset") → the AI Assistant
 *  - a command/tool/adjustment/filter/panel name ("curves", "relight", "brush")
 *    → runs it (the same registry as ⌘K)
 * It guesses intent: a sentence defaults to the assistant; a keyword that tightly
 * matches a command defaults to that command. Either is always one arrow away.
 *
 * This replaces the menu bar, tool-options strip, and panel dock as the DEFAULT
 * surface — everything else is summoned on demand.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import {
  useEngineSnapshot,
  useHistoryState,
  useViewExtras,
  engine,
} from "../../state/useEngine";
import { exportPng } from "../../engine/export";
import { useWorkspace, workspaceStore } from "../../state/workspace";
import { buildCommands, fuzzyScore, type Command } from "./commandRegistry";

type Row =
  | { kind: "ai"; text: string }
  | { kind: "cmd"; cmd: Command };

const SUGGESTIONS = ["make it warmer", "add curves", "relight", "remove background", "vintage look"];

async function exportPngDownload() {
  const blob = await exportPng(engine);
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = "ai-ps-export.png";
  a.click();
  URL.revokeObjectURL(url);
}

export function Omnibar() {
  const ws = useWorkspace();
  const snap = useEngineSnapshot();
  const history = useHistoryState();
  const view = useViewExtras();
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [query, setQuery] = useState("");
  const [sel, setSel] = useState(0);
  const [focused, setFocused] = useState(false);

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

  const { rows, defaultSel } = useMemo(() => {
    const q = query.trim();
    if (!q) return { rows: [] as Row[], defaultSel: 0 };
    const scored: { cmd: Command; score: number; order: number }[] = [];
    commands.forEach((cmd, order) => {
      const s = fuzzyScore(`${cmd.title} ${cmd.keywords ?? ""}`, q);
      if (s !== null) scored.push({ cmd, score: s, order });
    });
    scored.sort((a, b) => a.score - b.score || a.order - b.order);
    const top = scored.slice(0, 7);
    const aiRow: Row = { kind: "ai", text: q };
    const cmdRows: Row[] = top.map((x) => ({ kind: "cmd", cmd: x.cmd }));
    const rows = [aiRow, ...cmdRows];
    // A single keyword that tightly (substring) matches a command defaults to
    // that command; a sentence (or weak match) defaults to the assistant.
    const isSentence = q.includes(" ");
    const topStrong = top[0] && top[0].score < 1000;
    const defaultSel = !isSentence && topStrong ? 1 : 0;
    return { rows, defaultSel };
  }, [commands, query]);

  useEffect(() => setSel(defaultSel), [defaultSel, query]);

  const run = (row: Row | undefined) => {
    if (!row) return;
    if (row.kind === "ai") {
      const text = row.text.trim();
      if (text) workspaceStore.askAssistant(text);
    } else {
      if (row.cmd.enabled === false) return;
      row.cmd.run();
    }
    setQuery("");
    setSel(0);
    inputRef.current?.blur();
    setFocused(false);
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    e.stopPropagation(); // keep canvas tool shortcuts from firing while typing
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setSel((s) => Math.min(s + 1, rows.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setSel((s) => Math.max(s - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (e.metaKey || e.ctrlKey) {
        // Force the assistant regardless of selection.
        const text = query.trim();
        if (text) {
          workspaceStore.askAssistant(text);
          setQuery("");
          inputRef.current?.blur();
        }
        return;
      }
      run(rows[sel] ?? { kind: "ai", text: query });
    } else if (e.key === "Escape") {
      e.preventDefault();
      if (query) setQuery("");
      else inputRef.current?.blur();
    }
  };

  const showResults = focused && rows.length > 0;
  const showSuggest = focused && !query.trim();

  return (
    <div className="pointer-events-none absolute inset-x-0 bottom-6 z-30 flex justify-center px-4">
      <div className="animate-fadein pointer-events-auto w-[640px] max-w-[94vw]">
        {/* Results / suggestions float ABOVE the bar (bar sits at the bottom). */}
        {showResults && (
          <div className="animate-fadein mb-2 max-h-[44vh] overflow-y-auto rounded-xl border border-edge bg-panelraised/95 p-1 shadow-2xl backdrop-blur">
            {rows.map((row, i) => {
              const active = i === sel;
              if (row.kind === "ai") {
                return (
                  <button
                    key="ai"
                    onMouseEnter={() => setSel(i)}
                    onMouseDown={(e) => {
                      e.preventDefault();
                      run(row);
                    }}
                    className={`flex w-full items-center gap-3 rounded-lg px-3 py-2 text-left text-sm ${
                      active ? "bg-accent/25 text-ink" : "text-ink hover:bg-edge"
                    }`}
                  >
                    <span className="text-accent">✦</span>
                    <span className="min-w-0 flex-1 truncate">
                      Ask the assistant — <span className="text-muted">“{row.text}”</span>
                    </span>
                    <span className="shrink-0 rounded border border-edge px-1.5 py-0.5 text-[10px] text-muted">
                      ⏎
                    </span>
                  </button>
                );
              }
              const disabled = row.cmd.enabled === false;
              return (
                <button
                  key={row.cmd.id}
                  disabled={disabled}
                  onMouseEnter={() => setSel(i)}
                  onMouseDown={(e) => {
                    e.preventDefault();
                    run(row);
                  }}
                  className={`flex w-full items-center gap-3 rounded-lg px-3 py-2 text-left text-sm ${
                    disabled
                      ? "cursor-not-allowed text-muted/50"
                      : active
                        ? "bg-accent/25 text-ink"
                        : "text-ink hover:bg-edge"
                  }`}
                >
                  <span className="w-16 shrink-0 truncate text-[10px] uppercase tracking-wider text-muted">
                    {row.cmd.group}
                  </span>
                  <span className="min-w-0 flex-1 truncate">{row.cmd.title}</span>
                  {row.cmd.hint && (
                    <span className="shrink-0 rounded border border-edge px-1.5 py-0.5 text-[10px] text-muted">
                      {row.cmd.hint}
                    </span>
                  )}
                </button>
              );
            })}
          </div>
        )}

        {showSuggest && (
          <div className="animate-fadein mb-2 flex flex-wrap items-center gap-1.5 rounded-xl border border-edge bg-panelraised/90 px-3 py-2 text-xs shadow-2xl backdrop-blur">
            <span className="text-muted">Try</span>
            {SUGGESTIONS.map((s) => (
              <button
                key={s}
                onMouseDown={(e) => {
                  e.preventDefault();
                  workspaceStore.askAssistant(s);
                  setFocused(false);
                }}
                className="rounded-full border border-edge px-2.5 py-0.5 text-ink hover:bg-edge"
              >
                {s}
              </button>
            ))}
          </div>
        )}

        {/* The bar itself. */}
        <div
          className={`flex items-center gap-2.5 rounded-2xl border bg-panelraised/95 px-4 py-3 shadow-2xl backdrop-blur transition-colors ${
            focused ? "border-accent/70" : "border-edge"
          }`}
        >
          <span className="text-lg text-accent">✦</span>
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={onKeyDown}
            onFocus={() => setFocused(true)}
            onBlur={() => setTimeout(() => setFocused(false), 120)}
            placeholder="Describe an edit, or type a command…"
            className="min-w-0 flex-1 bg-transparent text-[15px] text-ink outline-none placeholder:text-muted"
            spellCheck={false}
            autoComplete="off"
          />
          <span className="hidden shrink-0 text-[11px] text-muted sm:block">
            ⏎ run · ⌘⏎ ask AI · ⌘K palette
          </span>
        </div>
      </div>
    </div>
  );
}
