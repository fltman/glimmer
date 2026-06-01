/**
 * Command registry — the data behind the ⌘K palette.
 *
 * Every tool, adjustment, filter, AI tool, panel, and view/edit/file action is
 * a `Command` here, so the palette can "do anything by name". This is what lets
 * the chrome stay hidden on a small screen: you don't need the menus and
 * buttons permanently on screen if you can summon any action by typing.
 *
 * Built per-render from a context (current toggle/flag state) so toggles know
 * what they're toggling and disabled actions (e.g. needs a layer) are greyed.
 */
import { actions } from "../../state/useEngine";
import { workspaceStore, type AiTab, type SidebarTab } from "../../state/workspace";
import { selectTool, TOOLS } from "../ToolRail";
import { ADJUSTMENTS, ADJUSTMENT_ORDER } from "../../engine/adjustments";
import { FILTERS, FILTER_ORDER } from "../../engine/filters";

export interface Command {
  id: string;
  title: string;
  group: string;
  /** Right-aligned hint (shortcut / extra info). */
  hint?: string;
  /** Extra search terms (not displayed). */
  keywords?: string;
  /** Default true; false renders greyed + non-runnable. */
  enabled?: boolean;
  run: () => void;
}

export interface CommandCtx {
  hasLayers: boolean;
  canUndo: boolean;
  canRedo: boolean;
  rulersVisible: boolean;
  gridVisible: boolean;
  snapEnabled: boolean;
  leftRail: boolean;
  rightDockOpen: boolean;
  /** Export the composite to a PNG download (lives in the Toolbar today). */
  onExport: () => void;
}

const AI_TABS: { id: AiTab; label: string }[] = [
  { id: "assistant", label: "Assistant" },
  { id: "generate", label: "Generate image" },
  { id: "edit", label: "Edit by prompt" },
  { id: "harmonize", label: "Harmonize" },
  { id: "relight", label: "Relight" },
  { id: "colormatch", label: "Color match" },
  { id: "reflection", label: "Remove reflections" },
  { id: "cutout", label: "Cut out / remove background" },
  { id: "distractions", label: "Cleanup / find distractions" },
  { id: "expand", label: "Expand / outpaint" },
  { id: "upscale", label: "Upscale" },
  { id: "presets", label: "Presets" },
];

const PANELS: { id: SidebarTab; label: string }[] = [
  { id: "ai", label: "AI" },
  { id: "adjust", label: "Adjustments" },
  { id: "history", label: "History" },
  { id: "paths", label: "Paths" },
  { id: "swatches", label: "Swatches" },
  { id: "channels", label: "Channels" },
];

export function buildCommands(ctx: CommandCtx): Command[] {
  const cmds: Command[] = [];

  // ── Tools ──
  for (const t of TOOLS) {
    cmds.push({
      id: `tool:${t.id}`,
      title: t.label,
      group: "Tools",
      hint: t.key,
      keywords: `tool ${t.id}`,
      run: () => selectTool(t.id),
    });
  }

  // ── Adjustments (need a layer to tune) ──
  for (const type of ADJUSTMENT_ORDER) {
    cmds.push({
      id: `adj:${type}`,
      title: ADJUSTMENTS[type].label,
      group: "Adjustments",
      keywords: `adjustment ${type}`,
      enabled: ctx.hasLayers,
      run: () => {
        actions.addAdjustmentLayer(type);
        workspaceStore.setRightTab("adjust");
      },
    });
  }

  // ── Filters (open the filter's dialog via a pending request) ──
  for (const type of FILTER_ORDER) {
    cmds.push({
      id: `filt:${type}`,
      title: FILTERS[type].label,
      group: "Filters",
      keywords: `filter ${type}`,
      enabled: ctx.hasLayers,
      run: () => workspaceStore.requestFilter(type),
    });
  }

  // ── AI tools (deep-link the AI dock) ──
  for (const a of AI_TABS) {
    cmds.push({
      id: `ai:${a.id}`,
      title: a.label,
      group: "AI",
      keywords: `ai ${a.id} ${a.label}`,
      run: () => workspaceStore.openAi(a.id),
    });
  }

  // ── Panels ──
  for (const p of PANELS) {
    cmds.push({
      id: `panel:${p.id}`,
      title: `${p.label} panel`,
      group: "Panels",
      keywords: `panel ${p.id} show open`,
      run: () => workspaceStore.setRightTab(p.id),
    });
  }

  // ── View / workspace ──
  cmds.push(
    {
      id: "view:fit",
      title: "Fit to screen",
      group: "View",
      hint: "⇧0",
      enabled: ctx.hasLayers,
      keywords: "zoom fit",
      run: () => actions.fit(),
    },
    {
      id: "view:reset",
      title: "Actual size (100%)",
      group: "View",
      keywords: "zoom reset 100",
      run: () => actions.resetView(),
    },
    {
      id: "view:rulers",
      title: ctx.rulersVisible ? "Hide rulers" : "Show rulers",
      group: "View",
      keywords: "rulers toggle",
      run: () => actions.setRulersVisible(!ctx.rulersVisible),
    },
    {
      id: "view:grid",
      title: ctx.gridVisible ? "Hide grid" : "Show grid",
      group: "View",
      keywords: "grid toggle",
      run: () => actions.setGridVisible(!ctx.gridVisible),
    },
    {
      id: "view:snap",
      title: ctx.snapEnabled ? "Disable snapping" : "Enable snapping",
      group: "View",
      keywords: "snap toggle",
      run: () => actions.setSnapEnabled(!ctx.snapEnabled),
    },
    {
      id: "view:left-rail",
      title: ctx.leftRail ? "Hide tool rail" : "Show tool rail",
      group: "View",
      keywords: "tools rail toggle hide",
      run: () => workspaceStore.toggleLeftRail(),
    },
    {
      id: "view:right-dock",
      title: ctx.rightDockOpen ? "Collapse panel dock" : "Expand panel dock",
      group: "View",
      keywords: "panels dock toggle collapse",
      run: () => workspaceStore.toggleRightDock(),
    },
    {
      id: "view:hide-chrome",
      title: "Hide all panels (full-bleed canvas)",
      group: "View",
      hint: "Tab",
      keywords: "focus zen full screen hide chrome panels tab",
      run: () => workspaceStore.toggleChrome(),
    },
  );

  // ── Edit ──
  cmds.push(
    {
      id: "edit:undo",
      title: "Undo",
      group: "Edit",
      hint: "⌘Z",
      enabled: ctx.canUndo,
      run: () => actions.undo(),
    },
    {
      id: "edit:redo",
      title: "Redo",
      group: "Edit",
      hint: "⇧⌘Z",
      enabled: ctx.canRedo,
      run: () => actions.redo(),
    },
    {
      id: "edit:select-all",
      title: "Select all",
      group: "Edit",
      hint: "⌘A",
      enabled: ctx.hasLayers,
      run: () => actions.selectAll(),
    },
    {
      id: "edit:deselect",
      title: "Deselect",
      group: "Edit",
      hint: "⌘D",
      run: () => actions.clearSelection(),
    },
    {
      id: "edit:invert",
      title: "Invert selection",
      group: "Edit",
      hint: "⇧⌘I",
      run: () => actions.invertSelection(),
    },
  );

  // ── File ──
  cmds.push(
    {
      id: "file:new",
      title: "New document",
      group: "File",
      keywords: "create blank",
      run: () => actions.newDocument({ width: 1024, height: 1024, title: "Untitled" }),
    },
    {
      id: "file:save",
      title: "Save project (.aips)",
      group: "File",
      hint: "⌘S",
      enabled: ctx.hasLayers,
      run: () => void actions.saveProject(),
    },
    {
      id: "file:export",
      title: "Export PNG",
      group: "File",
      enabled: ctx.hasLayers,
      keywords: "download save png",
      run: () => ctx.onExport(),
    },
  );

  return cmds;
}

/**
 * Fuzzy subsequence match + score. Returns null when `q` doesn't match. Lower
 * score = better (earlier/tighter match). Empty query matches everything.
 */
export function fuzzyScore(text: string, q: string): number | null {
  if (!q) return 0;
  const t = text.toLowerCase();
  const query = q.toLowerCase();
  // Fast path: contiguous substring is the best.
  const idx = t.indexOf(query);
  if (idx >= 0) return idx;
  // Subsequence fallback.
  let ti = 0;
  let score = 0;
  let last = -1;
  for (let qi = 0; qi < query.length; qi++) {
    const c = query[qi]!;
    const found = t.indexOf(c, ti);
    if (found < 0) return null;
    // Penalise gaps between matched chars (keeps "vig" -> "vignette" tight).
    score += found - last;
    last = found;
    ti = found + 1;
  }
  return 1000 + score; // worse than any substring match
}
