/**
 * History panel — a Photoshop-style list of history states.
 *
 * Reads the engine's command list reactively via `useHistoryEntries()`
 * ({ entries, currentIndex }). It NEVER touches pixels; clicking a row only
 * calls `actions.historyJumpTo(...)`, which replays undo/redo one step at a
 * time inside the engine.
 *
 * Semantics (see engine/history/History.ts):
 *  - `entries` is the full command list, oldest -> newest. `index` is each
 *    command's 0-based position in that list.
 *  - `currentIndex` is the number of APPLIED commands (the cursor sits AFTER
 *    the last applied command). A command at list index `i` is applied iff
 *    `i < currentIndex`.
 *  - `historyJumpTo(n)` lands so exactly `n` commands are applied (0 = the
 *    base/empty state). So selecting the command row at index `i` jumps to
 *    `i + 1`; the synthetic "Open" base row jumps to `0`.
 *
 * Rows ahead of the cursor (the redo branch) are dimmed, Photoshop-style, and
 * become live again only once you apply a new command past them.
 */
import { History as HistoryIcon } from "lucide-react";
import { useHistoryEntries, actions } from "../../state/useEngine";
import { EmptyState } from "../EmptyState";

/** Tiny clock glyph for the base/Open state. */
function BaseIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7v5l3 2" />
    </svg>
  );
}

/** A dot/diamond marking each recorded step. */
function StepIcon({ active }: { active: boolean }) {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" aria-hidden>
      <path
        d="M12 4 20 12 12 20 4 12Z"
        fill={active ? "currentColor" : "none"}
        stroke="currentColor"
        strokeWidth="2"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function HistoryPanel() {
  const { entries, currentIndex } = useHistoryEntries();

  // The base "Open" state is selected when nothing is applied yet.
  const baseSelected = currentIndex === 0;

  return (
    <div className="flex h-full flex-col">
      <div className="panel-title border-b border-edge">History</div>
      <div className="flex-1 overflow-y-auto">
        {/* Base / snapshot state — always present, sits at the top. */}
        <button
          type="button"
          onClick={() => actions.historyJumpTo(0)}
          className={`flex w-full items-center gap-2 border-b border-edge/60 px-3 py-2 text-left text-sm transition-colors ${
            baseSelected ? "bg-accent/15 text-ink" : "text-muted hover:bg-panelraised hover:text-ink"
          }`}
        >
          <span className={baseSelected ? "text-accent" : "text-muted"}>
            <BaseIcon />
          </span>
          <span className="flex-1 truncate">Open</span>
        </button>

        {entries.map((e) => {
          // `e.index` is 0-based; the command is applied iff index < currentIndex.
          const applied = e.index < currentIndex;
          // The single highlighted "current" row is the last applied command.
          const isCurrent = e.index === currentIndex - 1;
          // Rows ahead of the cursor are the redoable future — dim them.
          const isFuture = !applied;
          return (
            <button
              key={e.index}
              type="button"
              onClick={() => actions.historyJumpTo(e.index + 1)}
              className={`flex w-full items-center gap-2 border-b border-edge/60 px-3 py-2 text-left text-sm transition-colors ${
                isCurrent
                  ? "bg-accent/15 text-ink"
                  : isFuture
                    ? "text-muted/50 hover:bg-panelraised hover:text-muted"
                    : "text-ink hover:bg-panelraised"
              }`}
              title={isFuture ? `${e.label} (redo)` : e.label}
            >
              <span className={isCurrent ? "text-accent" : isFuture ? "text-muted/50" : "text-muted"}>
                <StepIcon active={applied} />
              </span>
              <span className="flex-1 truncate">{e.label}</span>
            </button>
          );
        })}

        {entries.length === 0 && (
          <EmptyState
            icon={HistoryIcon}
            title="No history yet"
            hint="Your edits will appear here as you work — click any step to jump back."
          />
        )}
      </div>
    </div>
  );
}
