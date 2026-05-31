/**
 * Left tool rail — selects the active tool in the tool store. Pure UI: it reads
 * and writes only `toolStore`; the engine reads the same store when routing
 * pointer events. Dark-themed to match the existing chrome.
 */
import { toolStore, useToolState, type ToolId } from "../state/tools";

interface ToolDef {
  id: ToolId;
  glyph: string;
  label: string;
  /** Single-key shortcut (shown in the tooltip; bound in App). */
  key: string;
}

export const TOOLS: ToolDef[] = [
  { id: "move", glyph: "✥", label: "Move", key: "V" },
  { id: "marquee-rect", glyph: "▭", label: "Rectangle marquee", key: "M" },
  { id: "marquee-ellipse", glyph: "◯", label: "Ellipse marquee", key: "M" },
  { id: "lasso", glyph: "✑", label: "Lasso", key: "L" },
  { id: "brush", glyph: "🖌", label: "Brush", key: "B" },
  { id: "eraser", glyph: "⌫", label: "Eraser", key: "E" },
  { id: "hand", glyph: "✋", label: "Hand (pan)", key: "H" },
];

export function ToolRail() {
  const { active } = useToolState();
  return (
    <div className="flex w-12 flex-col items-center gap-1 border-r border-edge bg-panel py-2">
      {TOOLS.map((t) => {
        const selected = t.id === active;
        return (
          <button
            key={t.id}
            onClick={() => toolStore.setActive(t.id)}
            className={`flex h-9 w-9 items-center justify-center rounded-md text-base transition-colors ${
              selected
                ? "bg-accent/20 text-ink ring-1 ring-accent/60"
                : "text-muted hover:bg-panelraised hover:text-ink"
            }`}
            title={`${t.label} (${t.key})`}
          >
            {t.glyph}
          </button>
        );
      })}
    </div>
  );
}
