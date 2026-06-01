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
import { DocumentTabs } from "./ui/DocumentTabs";
import { TextEditOverlay } from "./ui/text/TextEditOverlay";
import { LiquifyPanel } from "./ui/liquify";
import { LayersPanel } from "./ui/LayersPanel";
import { AIPanel } from "./ai/AIPanel";
import { AdjustmentsPanel } from "./ui/adjustments/AdjustmentsPanel";
import { HistoryPanel } from "./ui/history/HistoryPanel";
import { PathsPanel } from "./ui/paths/PathsPanel";
import { SwatchesPanel } from "./ui/swatches/SwatchesPanel";
import { ChannelsPanel } from "./ui/channels/ChannelsPanel";
import { engine, useEngineSnapshot, actions, isAgentBatching } from "./state/useEngine";
import { toolStore, type ToolId, type ShapeKind } from "./state/tools";
import {
  useWorkspace,
  workspaceStore,
  type SidebarTab,
} from "./state/workspace";
import { CommandPalette } from "./ui/command/CommandPalette";

/**
 * Single-key tool shortcuts (no modifier; ignored while typing). These map a
 * keystroke straight to toolStore.setActive. Keys whose behaviour is more than a
 * plain "select this tool" (M / U / T / C / O) are handled explicitly in the
 * keydown switch below, so they are intentionally NOT in this table.
 *
 * NOTE: X (swap fg/bg) and D (reset colors) are deliberately absent — they are
 * already bound in ui/color/ColorSwatches.tsx; binding them here would fire the
 * action twice.
 */
const KEY_TO_TOOL: Record<string, ToolId> = {
  v: "move",
  l: "lasso",
  w: "magic-wand",
  a: "sam-select",
  b: "brush",
  e: "eraser",
  j: "heal",
  s: "clone",
  g: "gradient",
  k: "bucket",
  y: "text",
  p: "pen",
  i: "eyedropper",
  h: "hand",
};

/** Shape primitives cycled by repeated taps of U. */
const SHAPE_CYCLE: ShapeKind[] = ["rect", "ellipse", "line"];

/** True when a keystroke should be ignored because the user is typing text. */
function isTypingTarget(e: KeyboardEvent): boolean {
  const el = e.target as HTMLElement | null;
  if (el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable)) {
    return true;
  }
  // Suppress shortcuts while a text layer is being edited, even if focus briefly
  // drifts off the editor's <textarea>.
  return engine.getActiveTextEditing() != null;
}

/**
 * Unmodified single-key tool shortcuts. Mirrors the keys advertised by the
 * ToolRail tooltips. The engine owns the Cmd/Ctrl combos (undo/redo/select-all/
 * deselect) and Space-hold panning; ColorSwatches owns X/D — none are touched
 * here.
 */
function useToolShortcuts() {
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.metaKey || e.ctrlKey) return; // engine handles Cmd/Ctrl combos
      if (isTypingTarget(e)) return;
      // Alt is only meaningful for Shift+O (burn) below; ignore other Alt combos
      // so they don't shadow OS / browser behaviour.
      if (e.altKey) return;

      const key = e.key.toLowerCase();

      switch (key) {
        // M — toggle between the two marquee shapes.
        case "m": {
          const cur = toolStore.get().active;
          toolStore.setActive(cur === "marquee-rect" ? "marquee-ellipse" : "marquee-rect");
          return;
        }
        // U — select the shape tool, cycling rect → ellipse → line on re-tap.
        case "u": {
          const ts = toolStore.get();
          if (ts.active === "shape") {
            const idx = SHAPE_CYCLE.indexOf(ts.shape.kind);
            toolStore.setShapeKind(SHAPE_CYCLE[(idx + 1) % SHAPE_CYCLE.length]!);
          } else {
            toolStore.setActive("shape");
          }
          return;
        }
        // O — dodge; Shift+O — burn.
        case "o":
          toolStore.setActive(e.shiftKey ? "burn" : "dodge");
          return;
        // T — begin a free-transform session (also makes "transform" active).
        case "t":
          actions.beginTransform();
          return;
        // C — begin a crop session (also makes "crop" active).
        case "c":
          actions.beginCrop();
          return;
      }

      // Plain tool keys don't take Shift; leave Shift combos for other handlers.
      if (e.shiftKey) return;

      const tool = KEY_TO_TOOL[key];
      if (tool) toolStore.setActive(tool);
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
}

/**
 * Editor-wide shortcuts that aren't tool selection: brush-size nudge ([ / ]) and
 * view zoom/fit (Cmd/Ctrl+0, Cmd/Ctrl+ +/-). Panning via Space-hold and the
 * Cmd/Ctrl undo/redo/select/deselect combos are handled inside the engine and
 * are not duplicated here.
 */
function useEditorShortcuts() {
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (isTypingTarget(e)) return;

      // ── View: zoom / fit (Cmd/Ctrl) ──────────────────────
      if (e.metaKey || e.ctrlKey) {
        // Cmd/Ctrl+0 → fit document to viewport.
        if (e.key === "0") {
          e.preventDefault();
          engine.fitToScreen();
          return;
        }
        // Cmd/Ctrl + "+" / "=" → zoom in; Cmd/Ctrl + "-" → zoom out. Anchor on
        // the canvas centre (CSS px) so the centred content stays put. The "="
        // key is accepted because "+" is Shift+"=" on most layouts.
        if (e.key === "+" || e.key === "=") {
          e.preventDefault();
          const c = engine.getViewRotationPivotCss();
          engine.zoomAt(1.25, c.x, c.y);
          return;
        }
        if (e.key === "-" || e.key === "_") {
          e.preventDefault();
          const c = engine.getViewRotationPivotCss();
          engine.zoomAt(1 / 1.25, c.x, c.y);
          return;
        }
        return; // leave all other Cmd/Ctrl combos to the engine
      }

      if (e.altKey) return;

      // ── Brush size nudge: [ smaller, ] larger ─────────────
      // Operates on the live brush size in document px; clamped to a sane range.
      if (e.key === "[" || e.key === "]") {
        e.preventDefault();
        const cur = toolStore.get().brush.size;
        // Larger steps for larger brushes feels natural: ~10%, with a 1px floor.
        const step = Math.max(1, Math.round(cur * 0.1));
        const next = e.key === "]" ? cur + step : cur - step;
        actions.setBrushParams({ size: Math.max(1, Math.min(2000, next)) });
        return;
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
}

/**
 * Workspace shortcuts for the adaptive, laptop-first chrome:
 *   ⌘K / Ctrl+K → command palette (anywhere, even while typing)
 *   Tab         → hide/show all chrome for a full-bleed canvas (not while typing)
 * Plus a resize listener that flips the workspace into "compact" (auto-collapsed
 * dock) below a width breakpoint so small laptops reclaim the canvas.
 */
function useWorkspaceShortcuts() {
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && (e.key === "k" || e.key === "K")) {
        e.preventDefault();
        workspaceStore.togglePalette();
        return;
      }
      if (e.key === "Tab" && !e.metaKey && !e.ctrlKey && !e.altKey) {
        if (isTypingTarget(e)) return;
        if (workspaceStore.getSnapshot().paletteOpen) return;
        e.preventDefault();
        workspaceStore.toggleChrome();
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  useEffect(() => {
    const apply = () => workspaceStore.setCompact(window.innerWidth < 1100);
    apply();
    window.addEventListener("resize", apply);
    return () => window.removeEventListener("resize", apply);
  }, []);
}

export default function App() {
  useToolShortcuts();
  useEditorShortcuts();
  useWorkspaceShortcuts();
  const ws = useWorkspace();
  const tab = ws.rightTab;
  const setTab = (t: SidebarTab) => workspaceStore.setRightTab(t);
  const snap = useEngineSnapshot();

  // Reveal the Adjust tab whenever an adjustment layer becomes active (e.g.
  // after Image ▸ Adjustments inserts one, or selecting it in the Layers
  // panel) so its properties / Curves / Levels editors are immediately visible.
  // EXCEPT during an agent batch (the Assistant/Presets running a multi-step
  // plan): each add_adjustment step would otherwise yank the user off the AI
  // tab and its live progress checklist. We keep them where they are.
  const active = snap.layers.find((l) => l.id === snap.activeLayerId) ?? null;
  const activeAdjId = active?.kind === "adjustment" ? active.id : null;
  useEffect(() => {
    if (activeAdjId && !isAgentBatching()) setTab("adjust");
  }, [activeAdjId]);

  return (
    <div className="flex h-full flex-col">
      {!ws.chromeHidden && <Toolbar />}
      {!ws.chromeHidden && <ToolOptions />}
      <div className="flex min-h-0 flex-1">
        {!ws.chromeHidden && ws.leftRail && <ToolRail />}
        {/* Center column (ALWAYS mounted — never remount <CanvasHost/> / the GL
            context). The document tab strip sits ABOVE the canvas, OUTSIDE
            <main> so it never shifts the canvas origin the type overlay uses. */}
        <div className="flex min-w-0 flex-1 flex-col">
          {!ws.chromeHidden && <DocumentTabs />}
          <main className="relative min-h-0 min-w-0 flex-1">
            <CanvasHost />
            <TextEditOverlay />
            {/* Floating Liquify controls; render only while warping. */}
            <LiquifyPanel />
            {/* Canvas-first launcher: ⌘K everywhere + a way back from focus mode. */}
            <FloatingControls chromeHidden={ws.chromeHidden} leftRail={ws.leftRail} />
          </main>
        </div>
        {!ws.chromeHidden &&
          (ws.rightDockOpen ? (
            <aside className="flex w-80 flex-col border-l border-edge bg-panel">
              <div className="flex shrink-0 items-stretch border-b border-edge">
                <div className="flex min-w-0 flex-1 overflow-x-auto">
                  <TabButton active={tab === "ai"} onClick={() => setTab("ai")}>
                    AI
                  </TabButton>
                  <TabButton active={tab === "adjust"} onClick={() => setTab("adjust")}>
                    Adjust
                  </TabButton>
                  <TabButton active={tab === "history"} onClick={() => setTab("history")}>
                    History
                  </TabButton>
                  <TabButton active={tab === "paths"} onClick={() => setTab("paths")}>
                    Paths
                  </TabButton>
                  <TabButton active={tab === "swatches"} onClick={() => setTab("swatches")}>
                    Swatch
                  </TabButton>
                  <TabButton active={tab === "channels"} onClick={() => setTab("channels")}>
                    Chan
                  </TabButton>
                </div>
                <button
                  onClick={() => workspaceStore.setRightDockOpen(false)}
                  title="Collapse panel dock"
                  className="shrink-0 border-l border-edge px-2 text-muted hover:bg-edge hover:text-ink"
                >
                  ▶
                </button>
              </div>
              <div className="min-h-0 flex-[3] overflow-hidden">
                {tab === "ai" ? (
                  <AIPanel />
                ) : tab === "adjust" ? (
                  <AdjustmentsPanel />
                ) : tab === "history" ? (
                  <HistoryPanel />
                ) : tab === "paths" ? (
                  <PathsPanel />
                ) : tab === "channels" ? (
                  <ChannelsPanel />
                ) : (
                  <SwatchesPanel />
                )}
              </div>
              <div className="min-h-0 flex-[2] overflow-hidden border-t border-edge">
                <LayersPanel />
              </div>
            </aside>
          ) : (
            <DockStrip activeTab={tab} />
          ))}
      </div>
      <CommandPalette />
    </div>
  );
}

/** Panels reachable from the collapsed dock strip + their glyphs. */
const DOCK_PANELS: { id: SidebarTab; glyph: string; label: string }[] = [
  { id: "ai", glyph: "✦", label: "AI" },
  { id: "adjust", glyph: "◐", label: "Adjustments" },
  { id: "history", glyph: "↺", label: "History" },
  { id: "paths", glyph: "✎", label: "Paths" },
  { id: "swatches", glyph: "🎨", label: "Swatches" },
  { id: "channels", glyph: "◫", label: "Channels" },
];

/** Collapsed right dock — a thin icon strip; click an icon to open that panel. */
function DockStrip({ activeTab }: { activeTab: SidebarTab }) {
  return (
    <aside className="flex w-11 shrink-0 flex-col items-center gap-1 border-l border-edge bg-panel py-2">
      <button
        onClick={() => workspaceStore.setRightDockOpen(true)}
        title="Expand panel dock"
        className="flex h-8 w-8 items-center justify-center rounded-md text-muted hover:bg-panelraised hover:text-ink"
      >
        ◀
      </button>
      <div className="my-1 h-px w-6 bg-edge" />
      {DOCK_PANELS.map((p) => (
        <button
          key={p.id}
          onClick={() => workspaceStore.setRightTab(p.id)}
          title={p.label}
          className={`flex h-8 w-8 items-center justify-center rounded-md text-sm transition-colors ${
            p.id === activeTab
              ? "bg-accent/20 text-ink ring-1 ring-accent/60"
              : "text-muted hover:bg-panelraised hover:text-ink"
          }`}
        >
          {p.glyph}
        </button>
      ))}
    </aside>
  );
}

/**
 * Canvas-corner launcher. The ⌘K button is always available (so the palette is
 * discoverable even with chrome hidden); in focus mode it also offers a visible
 * way back to the panels (besides the Tab key).
 */
function FloatingControls({
  chromeHidden,
  leftRail,
}: {
  chromeHidden: boolean;
  leftRail: boolean;
}) {
  return (
    <div className="pointer-events-none absolute right-2 top-2 z-20 flex items-center gap-1.5">
      {chromeHidden ? (
        <button
          onClick={() => workspaceStore.toggleChrome()}
          title="Show panels (Tab)"
          className="pointer-events-auto rounded-md border border-edge bg-panel/90 px-2 py-1 text-xs text-muted shadow-lg backdrop-blur hover:bg-edge hover:text-ink"
        >
          ⤢ Show UI
        </button>
      ) : (
        !leftRail && (
          <button
            onClick={() => workspaceStore.toggleLeftRail()}
            title="Show tool rail"
            className="pointer-events-auto rounded-md border border-edge bg-panel/90 px-2 py-1 text-xs text-muted shadow-lg backdrop-blur hover:bg-edge hover:text-ink"
          >
            ⧉ Tools
          </button>
        )
      )}
      <button
        onClick={() => workspaceStore.openPalette()}
        title="Command palette (⌘K)"
        className="pointer-events-auto rounded-md border border-edge bg-panel/90 px-2 py-1 text-xs font-medium text-muted shadow-lg backdrop-blur hover:bg-edge hover:text-ink"
      >
        ⌘K
      </button>
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
      className={`flex-1 px-1.5 py-2 text-[11px] font-semibold uppercase tracking-wide transition-colors ${
        active
          ? "border-b-2 border-accent text-ink"
          : "border-b-2 border-transparent text-muted hover:text-ink"
      }`}
    >
      {children}
    </button>
  );
}
