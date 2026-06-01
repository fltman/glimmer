/**
 * Workspace store — the adaptive, laptop-first chrome state.
 *
 * A tiny imperative store (mirrors toolStore) driving how much UI is on screen:
 * which right-dock panel is shown, whether the dock/rail are collapsed, whether
 * ALL chrome is hidden (Tab → full-bleed canvas), and whether the command
 * palette (⌘K) is open. It also carries a little cross-component UI routing
 * (the AI sub-tab + a pending-filter request) so the command palette can
 * "do anything by name" — deep-linking an AI tool or opening a filter dialog
 * without each surface owning private, unreachable state.
 *
 * The goal: on a small screen you can run any action via ⌘K and keep the canvas
 * full-width, summoning a panel only when you need it.
 */
import { useSyncExternalStore } from "react";
import type { AdjustmentType } from "../engine/adjustments";
import type { FilterType } from "../engine/filters";

/** The right-dock panels. */
export type SidebarTab =
  | "ai"
  | "adjust"
  | "history"
  | "paths"
  | "swatches"
  | "channels";

/** AI sub-panels (mirrors AIPanel's TabId — kept in sync by string value). */
export type AiTab =
  | "assistant"
  | "generate"
  | "edit"
  | "harmonize"
  | "relight"
  | "colormatch"
  | "reflection"
  | "cutout"
  | "distractions"
  | "expand"
  | "upscale"
  | "presets";

export interface WorkspaceState {
  /** Left tool rail visible. */
  leftRail: boolean;
  /** Right dock expanded (full panel) vs collapsed (thin icon strip). */
  rightDockOpen: boolean;
  /** Which right-dock panel is active. */
  rightTab: SidebarTab;
  /** Active AI sub-tab (controlled so ⌘K can deep-link an AI tool). */
  aiTab: AiTab;
  /** Hide ALL chrome for a full-bleed canvas (Tab). */
  chromeHidden: boolean;
  /** Command palette (⌘K) open. */
  paletteOpen: boolean;
  /**
   * A one-shot filter-open request: ⌘K sets this; the FiltersMenu watches it,
   * opens that filter's dialog, then clears it. null = no pending request.
   */
  pendingFilter: FilterType | null;
  /** Adjustment to add (one-shot, same pattern) — lets ⌘K add an adjustment. */
  pendingAdjustment: AdjustmentType | null;
  /** True when the viewport is narrow enough to default to a collapsed dock. */
  compact: boolean;
}

type Listener = () => void;

class WorkspaceStore {
  private state: WorkspaceState = {
    leftRail: true,
    rightDockOpen: true,
    rightTab: "ai",
    aiTab: "assistant",
    chromeHidden: false,
    paletteOpen: false,
    pendingFilter: null,
    pendingAdjustment: null,
    compact: false,
  };
  private listeners = new Set<Listener>();

  subscribe = (cb: Listener): (() => void) => {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  };
  getSnapshot = (): WorkspaceState => this.state;

  private set(patch: Partial<WorkspaceState>): void {
    this.state = { ...this.state, ...patch };
    for (const cb of this.listeners) cb();
  }

  // ── dock / rail / chrome ──
  setRightTab(tab: SidebarTab): void {
    this.set({ rightTab: tab, rightDockOpen: true, chromeHidden: false });
  }
  toggleRightDock(): void {
    this.set({ rightDockOpen: !this.state.rightDockOpen });
  }
  setRightDockOpen(open: boolean): void {
    this.set({ rightDockOpen: open });
  }
  toggleLeftRail(): void {
    this.set({ leftRail: !this.state.leftRail });
  }
  toggleChrome(): void {
    // Tab: when showing chrome again, also restore the dock if it was open.
    this.set({ chromeHidden: !this.state.chromeHidden });
  }
  setCompact(compact: boolean): void {
    if (compact === this.state.compact) return;
    // On entering compact (narrow viewport) collapse the dock to reclaim canvas;
    // on leaving, re-expand it. Only flips the dock, never fights a manual toggle
    // within the same breakpoint.
    this.set({ compact, rightDockOpen: !compact });
  }

  // ── command palette ──
  openPalette(): void {
    this.set({ paletteOpen: true });
  }
  closePalette(): void {
    this.set({ paletteOpen: false });
  }
  togglePalette(): void {
    this.set({ paletteOpen: !this.state.paletteOpen });
  }

  // ── routing for ⌘K deep-links ──
  openAi(aiTab: AiTab): void {
    this.set({
      aiTab,
      rightTab: "ai",
      rightDockOpen: true,
      chromeHidden: false,
      paletteOpen: false,
    });
  }
  setAiTab(aiTab: AiTab): void {
    this.set({ aiTab });
  }
  requestFilter(filter: FilterType): void {
    this.set({ pendingFilter: filter, paletteOpen: false });
  }
  clearPendingFilter(): void {
    if (this.state.pendingFilter !== null) this.set({ pendingFilter: null });
  }
  requestAdjustment(type: AdjustmentType): void {
    this.set({
      pendingAdjustment: type,
      rightTab: "adjust",
      paletteOpen: false,
    });
  }
  clearPendingAdjustment(): void {
    if (this.state.pendingAdjustment !== null)
      this.set({ pendingAdjustment: null });
  }
}

export const workspaceStore = new WorkspaceStore();

export function useWorkspace(): WorkspaceState {
  return useSyncExternalStore(
    workspaceStore.subscribe,
    workspaceStore.getSnapshot,
    workspaceStore.getSnapshot,
  );
}
