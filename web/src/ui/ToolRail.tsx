/**
 * Left tool rail — selects the active tool in the tool store. Pure UI: it reads
 * and writes only `toolStore`; the engine reads the same store when routing
 * pointer events. Dark-themed to match the existing chrome.
 */
import { Fragment } from "react";
import { toolStore, useToolState, type ToolId } from "../state/tools";
import { ColorControls } from "./color";

interface ToolDef {
  id: ToolId;
  glyph: string;
  label: string;
  /** Single-key shortcut (shown in the tooltip; bound in App). */
  key: string;
  /** Tools sharing a group are kept together; a divider falls between groups. */
  group: number;
}

export const TOOLS: ToolDef[] = [
  { id: "move", glyph: "✥", label: "Move", key: "V", group: 0 },
  { id: "marquee-rect", glyph: "▭", label: "Rectangle marquee", key: "M", group: 1 },
  { id: "marquee-ellipse", glyph: "◯", label: "Ellipse marquee", key: "M", group: 1 },
  { id: "lasso", glyph: "✑", label: "Lasso", key: "L", group: 1 },
  { id: "brush", glyph: "🖌", label: "Brush", key: "B", group: 2 },
  { id: "eraser", glyph: "⌫", label: "Eraser", key: "E", group: 2 },
  { id: "bucket", glyph: "🪣", label: "Paint bucket", key: "K", group: 2 },
  { id: "gradient", glyph: "🌈", label: "Gradient", key: "G", group: 2 },
  { id: "eyedropper", glyph: "💧", label: "Eyedropper", key: "I", group: 3 },
  { id: "hand", glyph: "✋", label: "Hand (pan)", key: "H", group: 3 },
];

export function ToolRail() {
  const { active } = useToolState();
  return (
    <div className="flex w-12 flex-col items-center border-r border-edge bg-panel py-2">
      <div className="flex flex-1 flex-col items-center gap-1">
        {TOOLS.map((t, i) => {
          const prev = TOOLS[i - 1];
          const dividerBefore = prev !== undefined && prev.group !== t.group;
          const selected = t.id === active;
          return (
            <Fragment key={t.id}>
              {dividerBefore && <div className="my-1 h-px w-6 bg-edge" />}
              <button
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
            </Fragment>
          );
        })}
      </div>
      {/* Foreground / background color + picker, always visible at the foot. */}
      <div className="mt-2 border-t border-edge pt-2">
        <ColorControls />
      </div>
    </div>
  );
}
