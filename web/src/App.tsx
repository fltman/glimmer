/**
 * App shell — dark pro-editor layout:
 *   top bar  |  tool options bar
 *   left tool rail  |  center canvas  |  right panels
 * The canvas host is mounted once and lives between the rails and the panels.
 */
import { useEffect } from "react";
import { Toolbar } from "./ui/Toolbar";
import { ToolRail } from "./ui/ToolRail";
import { ToolOptions } from "./ui/ToolOptions";
import { CanvasHost } from "./ui/CanvasHost";
import { LayersPanel } from "./ui/LayersPanel";
import { AIPanel } from "./ai/AIPanel";
import { toolStore, type ToolId } from "./state/tools";

/** Single-key tool shortcuts (ignored while typing in inputs). */
const KEY_TO_TOOL: Record<string, ToolId> = {
  v: "move",
  m: "marquee-rect",
  l: "lasso",
  b: "brush",
  e: "eraser",
  h: "hand",
};

function useToolShortcuts() {
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const el = e.target as HTMLElement | null;
      if (el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable)) {
        return;
      }
      const key = e.key.toLowerCase();
      // Tapping M toggles between the two marquee shapes.
      if (key === "m") {
        const cur = toolStore.get().active;
        toolStore.setActive(cur === "marquee-rect" ? "marquee-ellipse" : "marquee-rect");
        return;
      }
      const tool = KEY_TO_TOOL[key];
      if (tool) toolStore.setActive(tool);
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
}

export default function App() {
  useToolShortcuts();
  return (
    <div className="flex h-full flex-col">
      <Toolbar />
      <ToolOptions />
      <div className="flex min-h-0 flex-1">
        <ToolRail />
        <main className="min-w-0 flex-1">
          <CanvasHost />
        </main>
        <aside className="flex w-80 flex-col border-l border-edge bg-panel">
          <div className="min-h-0 flex-[3] overflow-hidden">
            <AIPanel />
          </div>
          <div className="min-h-0 flex-[2] overflow-hidden border-t border-edge">
            <LayersPanel />
          </div>
        </aside>
      </div>
    </div>
  );
}
