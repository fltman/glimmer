/**
 * App shell — dark pro-editor layout:
 *   top bar  |  tool options bar
 *   left tool rail  |  center canvas  |  right panels
 * The canvas host is mounted once and lives between the rails and the panels.
 */
import { useEffect, useState } from "react";
import { Toolbar } from "./ui/Toolbar";
import { ToolRail } from "./ui/ToolRail";
import { ToolOptions } from "./ui/ToolOptions";
import { CanvasHost } from "./ui/CanvasHost";
import { TextEditOverlay } from "./ui/text/TextEditOverlay";
import { LayersPanel } from "./ui/LayersPanel";
import { AIPanel } from "./ai/AIPanel";
import { AdjustmentsPanel } from "./ui/adjustments/AdjustmentsPanel";
import { HistoryPanel } from "./ui/history/HistoryPanel";
import { engine, useEngineSnapshot } from "./state/useEngine";
import { toolStore, type ToolId } from "./state/tools";

/** Single-key tool shortcuts (ignored while typing in inputs). */
const KEY_TO_TOOL: Record<string, ToolId> = {
  v: "move",
  m: "marquee-rect",
  l: "lasso",
  b: "brush",
  e: "eraser",
  g: "gradient",
  i: "eyedropper",
  k: "bucket",
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
      // Suppress single-key tool shortcuts while a text layer is being edited,
      // even if focus briefly drifts off the editor's textarea.
      if (engine.getActiveTextEditing()) return;
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

type SidebarTab = "ai" | "adjust" | "history";

export default function App() {
  useToolShortcuts();
  const [tab, setTab] = useState<SidebarTab>("ai");
  const snap = useEngineSnapshot();

  // Reveal the Adjust tab whenever an adjustment layer becomes active (e.g.
  // after Image ▸ Adjustments inserts one, or selecting it in the Layers
  // panel) so its properties / Curves / Levels editors are immediately visible.
  const active = snap.layers.find((l) => l.id === snap.activeLayerId) ?? null;
  const activeAdjId = active?.kind === "adjustment" ? active.id : null;
  useEffect(() => {
    if (activeAdjId) setTab("adjust");
  }, [activeAdjId]);

  return (
    <div className="flex h-full flex-col">
      <Toolbar />
      <ToolOptions />
      <div className="flex min-h-0 flex-1">
        <ToolRail />
        {/* Relative wrapper so the type-tool <textarea> overlay (positioned in
            CSS px from the engine's view transform) aligns with the canvas,
            which fills this element edge-to-edge. */}
        <main className="relative min-w-0 flex-1">
          <CanvasHost />
          <TextEditOverlay />
        </main>
        <aside className="flex w-80 flex-col border-l border-edge bg-panel">
          {/* Tabbed top section: AI tools / Adjustments / History. */}
          <div className="flex shrink-0 border-b border-edge">
            <TabButton active={tab === "ai"} onClick={() => setTab("ai")}>
              AI
            </TabButton>
            <TabButton active={tab === "adjust"} onClick={() => setTab("adjust")}>
              Adjust
            </TabButton>
            <TabButton active={tab === "history"} onClick={() => setTab("history")}>
              History
            </TabButton>
          </div>
          <div className="min-h-0 flex-[3] overflow-hidden">
            {tab === "ai" ? (
              <AIPanel />
            ) : tab === "adjust" ? (
              <AdjustmentsPanel />
            ) : (
              <HistoryPanel />
            )}
          </div>
          <div className="min-h-0 flex-[2] overflow-hidden border-t border-edge">
            <LayersPanel />
          </div>
        </aside>
      </div>
    </div>
  );
}

function TabButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      className={`flex-1 px-3 py-2 text-xs font-semibold uppercase tracking-wider transition-colors ${
        active
          ? "border-b-2 border-accent text-ink"
          : "border-b-2 border-transparent text-muted hover:text-ink"
      }`}
    >
      {children}
    </button>
  );
}
