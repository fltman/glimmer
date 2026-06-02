/**
 * App shell — dark pro-editor layout:
 *   top bar  |  tool options bar
 *   left tool rail  |  center canvas  |  right panels
 * The canvas host is mounted once and lives between the rails and the panels.
 */
import { useEffect, useRef, useState } from "react";
import {
  Sparkles,
  SlidersHorizontal,
  History as HistoryIcon,
  PenTool,
  SwatchBook,
  Component,
  ChevronLeft,
  ChevronRight,
  PanelsTopLeft,
  PencilRuler,
  Command,
  type LucideIcon,
} from "lucide-react";
import { Toolbar } from "./ui/Toolbar";
import { ToolRail } from "./ui/ToolRail";
import { ToolOptions, ToolOptionsBody, toolHasOptions } from "./ui/ToolOptions";
import { CanvasHost } from "./ui/CanvasHost";
import { DocumentTabs } from "./ui/DocumentTabs";
import { TextEditOverlay } from "./ui/text/TextEditOverlay";
import { LiquifyPanel } from "./ui/liquify";
import { LensBlurPanel } from "./ui/lensblur";
import { ContentAwareFillModal } from "./ai/contentAware";
import { LayersPanel } from "./ui/LayersPanel";
import { AIPanel } from "./ai/AIPanel";
import { AdjustmentsPanel } from "./ui/adjustments/AdjustmentsPanel";
import { HistoryPanel } from "./ui/history/HistoryPanel";
import { PathsPanel } from "./ui/paths/PathsPanel";
import { SwatchesPanel } from "./ui/swatches/SwatchesPanel";
import { ChannelsPanel } from "./ui/channels/ChannelsPanel";
import { engine, useEngineSnapshot, actions, isAgentBatching } from "./state/useEngine";
import { toolStore, useToolState, type ToolId, type ShapeKind } from "./state/tools";
import {
  useWorkspace,
  workspaceStore,
  type SidebarTab,
  type FloatPanel,
} from "./state/workspace";
import { CommandPalette } from "./ui/command/CommandPalette";
import { Omnibar } from "./ui/command/Omnibar";
import { OmniChrome } from "./ui/OmniChrome";
import { FloatingPanel } from "./ui/FloatingPanel";

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

/**
 * Open an image file the most intuitive way: if the current document is empty,
 * the dropped/pasted/opened image BECOMES the document (sized to it, and the
 * leftover blank tab is dropped); otherwise it's placed as a new layer in the
 * current document.
 */
async function openImageFile(file: Blob): Promise<void> {
  if (!file.type.startsWith("image/")) return;
  const prevId = engine.getActiveDocumentId();
  const empty = engine.getSnapshot().layers.length === 0;
  if (empty) {
    const newId = await actions.openImageAsDocument(file);
    if (prevId && prevId !== newId) actions.closeDocument(prevId);
  } else {
    await engine.loadImageLayer(file);
  }
}

export default function App() {
  useToolShortcuts();
  useEditorShortcuts();
  useWorkspaceShortcuts();

  // Paste an image from the clipboard (⌘V) anywhere → open it.
  useEffect(() => {
    function onPaste(e: ClipboardEvent) {
      const items = e.clipboardData?.items;
      if (!items) return;
      for (const it of items) {
        if (it.kind === "file" && it.type.startsWith("image/")) {
          const f = it.getAsFile();
          if (f) {
            e.preventDefault();
            void openImageFile(f);
            return;
          }
        }
      }
    }
    window.addEventListener("paste", onPaste);
    return () => window.removeEventListener("paste", onPaste);
  }, []);
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

  const omni = ws.mode === "omni";
  const activeTool = useToolState().active;
  const [dragOver, setDragOver] = useState(false);
  const openFileRef = useRef<HTMLInputElement | null>(null);
  const isEmpty = snap.layers.length === 0;

  return (
    <div className="flex h-full flex-col">
      {/* Classic docked chrome (hidden in omni mode + focus mode). */}
      {!omni && !ws.chromeHidden && <Toolbar />}
      {!omni && !ws.chromeHidden && <ToolOptions />}
      <div className="flex min-h-0 flex-1">
        {!omni && !ws.chromeHidden && ws.leftRail && <ToolRail />}
        {/* Center column (ALWAYS mounted, IDENTICAL across modes — never remount
            <CanvasHost/> / the GL context). */}
        <div className="flex min-w-0 flex-1 flex-col">
          {!omni && !ws.chromeHidden && <DocumentTabs />}
          <main
            className="relative min-h-0 min-w-0 flex-1"
            onDragOver={(e) => {
              if (e.dataTransfer?.types.includes("Files")) {
                e.preventDefault();
                if (!dragOver) setDragOver(true);
              }
            }}
            onDragLeave={(e) => {
              // Only clear when the pointer actually leaves the <main> bounds.
              if (e.currentTarget === e.target) setDragOver(false);
            }}
            onDrop={(e) => {
              e.preventDefault();
              setDragOver(false);
              const f = e.dataTransfer?.files?.[0];
              if (f) void openImageFile(f);
            }}
          >
            <CanvasHost />
            <TextEditOverlay />
            {/* Floating modal-session controls; each self-gates on its engine
                session, so they're safe to always mount. Mounting here (not just
                in the classic toolbar) makes Liquify / Lens Blur reachable in the
                omni workspace via ⌘K. */}
            <LiquifyPanel />
            <LensBlurPanel />
            {ws.contentAwareFillOpen && (
              <ContentAwareFillModal
                onClose={() => workspaceStore.closeContentAwareFill()}
              />
            )}

            {/* Hidden file input backing the "Open image" affordances. */}
            <input
              ref={openFileRef}
              type="file"
              accept="image/*"
              className="hidden"
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) void openImageFile(f);
                e.target.value = "";
              }}
            />

            {/* Drag-to-open overlay. */}
            {dragOver && (
              <div className="animate-fadein pointer-events-none absolute inset-3 z-50 flex items-center justify-center rounded-2xl border-2 border-dashed border-accent/70 bg-accent/10 backdrop-blur-sm">
                <span className="rounded-lg border border-edge bg-panel/90 px-4 py-2 text-sm font-medium text-ink shadow-xl">
                  Drop image to open
                </span>
              </div>
            )}

            {/* First-run guidance on an empty canvas (omni mode). */}
            {omni && isEmpty && (
              <EmptyCanvasHero onOpen={() => openFileRef.current?.click()} />
            )}

            {/* ── OMNI MODE: full-screen canvas + omnibar; everything summoned ── */}
            {omni && <OmniChrome />}
            {omni && <Omnibar />}
            {omni && ws.toolsOpen && (
              <>
                {/* Floating tool rail (clears the doc pill above + omnibar below).
                    Sizes to its content (two columns, no scroll) and is NOT
                    overflow-clipped, so the tool flyouts + colour picker can
                    open beyond the card edge. */}
                <div className="animate-fadein pointer-events-auto absolute bottom-20 left-3 top-16 z-30 flex max-h-[calc(100vh-9rem)] items-start rounded-xl border border-edge bg-panel/95 shadow-2xl backdrop-blur">
                  <ToolRail />
                </div>
                {/* Contextual options — ONLY the active tool's controls, and only
                    when the tool actually has options (move/hand/eyedropper don't). */}
                {toolHasOptions(activeTool) && (
                  // No overflow clipping here — the Text/Shape/Gradient/Brush
                  // controls open color-picker / dynamics popovers BELOW their
                  // buttons, which an overflow container would crop.
                  <div className="animate-fadein pointer-events-auto absolute left-1/2 top-3 z-20 flex w-fit max-w-[90vw] -translate-x-1/2 items-center gap-3 rounded-xl border border-edge bg-panel/95 px-3 py-1.5 shadow-2xl backdrop-blur">
                    <span className="shrink-0 text-[11px] font-semibold uppercase tracking-wider text-muted">
                      {activeTool.replace("-", " ")}
                    </span>
                    <ToolOptionsBody />
                  </div>
                )}
              </>
            )}
            {omni && ws.floatingPanel && (
              <FloatingPanel
                title={PANEL_TITLE[ws.floatingPanel]}
                onClose={() => workspaceStore.closeFloatingPanel()}
              >
                {renderPanel(ws.floatingPanel)}
              </FloatingPanel>
            )}

            {/* Classic focus-mode launcher (⌘K + way back from Tab). */}
            {!omni && (
              <FloatingControls chromeHidden={ws.chromeHidden} leftRail={ws.leftRail} />
            )}
          </main>
        </div>
        {!omni &&
          !ws.chromeHidden &&
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
                  className="flex shrink-0 items-center border-l border-edge px-1.5 text-muted hover:bg-edge hover:text-ink"
                >
                  <ChevronRight size={15} />
                </button>
              </div>
              <div className="flex min-h-0 flex-[3] flex-col overflow-hidden">
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

/** Titles for the floating (summoned) panels in omni mode. */
const PANEL_TITLE: Record<FloatPanel, string> = {
  ai: "Assistant & AI",
  adjust: "Adjustments",
  history: "History",
  paths: "Paths",
  swatches: "Swatches",
  channels: "Channels",
  layers: "Layers",
};

/** Render the panel a floating card hosts in omni mode. */
function renderPanel(panel: FloatPanel) {
  switch (panel) {
    case "ai":
      return <AIPanel />;
    case "adjust":
      return <AdjustmentsPanel />;
    case "history":
      return <HistoryPanel />;
    case "paths":
      return <PathsPanel />;
    case "swatches":
      return <SwatchesPanel />;
    case "channels":
      return <ChannelsPanel />;
    case "layers":
      return <LayersPanel />;
  }
}

/** First-run invitation shown over an empty canvas in omni mode. */
function EmptyCanvasHero({ onOpen }: { onOpen: () => void }) {
  return (
    <div className="animate-fadein pointer-events-none absolute inset-0 z-10 flex items-center justify-center px-6 pb-24">
      {/* Subtle glass card so the copy reads cleanly over the checkerboard. */}
      <div className="flex max-w-md flex-col items-center gap-5 rounded-2xl border border-edge/70 bg-panel/70 px-10 py-9 text-center shadow-2xl backdrop-blur-md">
        <div className="flex h-14 w-14 items-center justify-center rounded-2xl bg-gradient-to-br from-accent to-fuchsia-500 text-white shadow-lg">
          <Sparkles size={26} strokeWidth={1.75} />
        </div>
        <div className="space-y-2">
          <h1 className="text-xl font-semibold text-ink">Start with an image</h1>
          <p className="text-sm leading-relaxed text-muted">
            Drop a file anywhere, paste from your clipboard, or open one — or just
            describe an image in the bar below and AI generates it.
          </p>
        </div>
        <div className="pointer-events-auto flex items-center gap-2.5">
          <button
            onClick={onOpen}
            className="rounded-lg bg-accent px-4 py-2 text-sm font-medium text-white shadow-lg transition duration-100 hover:bg-accenthover active:scale-[0.97]"
          >
            Open image
          </button>
          <button
            onClick={() => workspaceStore.openPalette()}
            className="rounded-lg border border-edge bg-panelraised px-4 py-2 text-sm text-muted transition duration-100 hover:bg-edge hover:text-ink active:scale-[0.97]"
          >
            ⌘K commands
          </button>
        </div>
      </div>
    </div>
  );
}

/** Panels reachable from the collapsed dock strip + their icons. */
const DOCK_PANELS: { id: SidebarTab; Icon: LucideIcon; label: string }[] = [
  { id: "ai", Icon: Sparkles, label: "AI" },
  { id: "adjust", Icon: SlidersHorizontal, label: "Adjustments" },
  { id: "history", Icon: HistoryIcon, label: "History" },
  { id: "paths", Icon: PenTool, label: "Paths" },
  { id: "swatches", Icon: SwatchBook, label: "Swatches" },
  { id: "channels", Icon: Component, label: "Channels" },
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
        <ChevronLeft size={16} />
      </button>
      <div className="my-1 h-px w-6 bg-edge" />
      {DOCK_PANELS.map((p) => (
        <button
          key={p.id}
          onClick={() => workspaceStore.setRightTab(p.id)}
          title={p.label}
          className={`flex h-8 w-8 items-center justify-center rounded-md transition-colors ${
            p.id === activeTab
              ? "bg-accent/20 text-ink ring-1 ring-accent/60"
              : "text-muted hover:bg-panelraised hover:text-ink"
          }`}
        >
          <p.Icon size={16} strokeWidth={1.75} />
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
          className="pointer-events-auto flex items-center gap-1.5 rounded-md border border-edge bg-panel/90 px-2 py-1.5 text-xs text-muted shadow-lg backdrop-blur hover:bg-edge hover:text-ink"
        >
          <PanelsTopLeft size={13} /> Show UI
        </button>
      ) : (
        !leftRail && (
          <button
            onClick={() => workspaceStore.toggleLeftRail()}
            title="Show tool rail"
            className="pointer-events-auto flex items-center gap-1.5 rounded-md border border-edge bg-panel/90 px-2 py-1.5 text-xs text-muted shadow-lg backdrop-blur hover:bg-edge hover:text-ink"
          >
            <PencilRuler size={13} /> Tools
          </button>
        )
      )}
      <button
        onClick={() => workspaceStore.openPalette()}
        title="Command palette (⌘K)"
        className="pointer-events-auto flex items-center rounded-md border border-edge bg-panel/90 p-1.5 text-xs font-medium text-muted shadow-lg backdrop-blur hover:bg-edge hover:text-ink"
      >
        <Command size={14} />
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
