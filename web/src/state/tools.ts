/**
 * Tool + brush parameter store.
 *
 * A tiny imperative store with useSyncExternalStore bindings, mirroring the
 * engine-snapshot pattern. The engine reads tool state synchronously (via the
 * exported `toolStore` getter) when routing pointer events; React reads it
 * reactively for the tool rail and options bar. React never touches pixels.
 */
import { useSyncExternalStore } from "react";

export type ToolId =
  | "move"
  | "brush"
  | "eraser"
  | "marquee-rect"
  | "marquee-ellipse"
  | "lasso"
  | "hand"
  | "eyedropper"
  | "bucket"
  | "gradient";

/** Boolean op applied when a new selection is committed (driven by modifiers). */
export type SelectionOp = "replace" | "add" | "subtract" | "intersect";

/**
 * An RGBA color in straight (non-premultiplied) sRGB space, components 0..1.
 * This is the authoritative color representation used by the UI swatches; the
 * engine converts to linear light when it paints/fills.
 */
export interface RGBAColor {
  r: number;
  g: number;
  b: number;
  a: number;
}

export interface BrushParams {
  /** Diameter in document px. */
  size: number;
  /** Master stroke opacity 0..1. */
  opacity: number;
  /** Edge softness 0..1 (1 = hard). */
  hardness: number;
  /** Per-dab build-up 0..1. */
  flow: number;
}

export interface ToolState {
  active: ToolId;
  brush: BrushParams;
  /** Selection feather radius in px applied on commit. */
  feather: number;
  /** Foreground color (brush/bucket/gradient "from"). sRGB straight, 0..1. */
  foreground: RGBAColor;
  /** Background color (gradient "to" / canvas fills). sRGB straight, 0..1. */
  background: RGBAColor;
}

const DEFAULT: ToolState = {
  active: "brush",
  brush: { size: 48, opacity: 1, hardness: 0.8, flow: 1 },
  feather: 0,
  foreground: { r: 0, g: 0, b: 0, a: 1 },
  background: { r: 1, g: 1, b: 1, a: 1 },
};

type Listener = () => void;

class ToolStore {
  private state: ToolState = DEFAULT;
  private listeners = new Set<Listener>();

  get(): ToolState {
    return this.state;
  }

  subscribe(cb: Listener): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  private set(next: ToolState): void {
    this.state = next;
    for (const cb of this.listeners) cb();
  }

  setActive(active: ToolId): void {
    if (this.state.active === active) return;
    this.set({ ...this.state, active });
  }

  setBrush(patch: Partial<BrushParams>): void {
    this.set({ ...this.state, brush: { ...this.state.brush, ...patch } });
  }

  setFeather(feather: number): void {
    this.set({ ...this.state, feather: Math.max(0, feather) });
  }

  // ── color ──────────────────────────────────────────────
  setForeground(color: RGBAColor): void {
    this.set({ ...this.state, foreground: clampColor(color) });
  }

  setBackground(color: RGBAColor): void {
    this.set({ ...this.state, background: clampColor(color) });
  }

  /** Swap foreground <-> background (Photoshop X). */
  swapColors(): void {
    this.set({
      ...this.state,
      foreground: this.state.background,
      background: this.state.foreground,
    });
  }

  /** Reset to default black foreground / white background (Photoshop D). */
  resetColors(): void {
    this.set({
      ...this.state,
      foreground: { r: 0, g: 0, b: 0, a: 1 },
      background: { r: 1, g: 1, b: 1, a: 1 },
    });
  }
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}
function clampColor(c: RGBAColor): RGBAColor {
  return { r: clamp01(c.r), g: clamp01(c.g), b: clamp01(c.b), a: clamp01(c.a) };
}

export const toolStore = new ToolStore();

export function useToolState(): ToolState {
  return useSyncExternalStore(
    (cb) => toolStore.subscribe(cb),
    () => toolStore.get(),
    () => toolStore.get(),
  );
}

/** True for tools that paint into a layer / mask (brush family). */
export function isPaintTool(t: ToolId): boolean {
  return t === "brush" || t === "eraser";
}

/** True for the marquee/lasso selection tools. */
export function isSelectionTool(t: ToolId): boolean {
  return t === "marquee-rect" || t === "marquee-ellipse" || t === "lasso";
}

/** Resolve the boolean op from keyboard modifiers on a pointerdown. */
export function selectionOpFromEvent(e: PointerEvent | MouseEvent): SelectionOp {
  if (e.shiftKey && e.altKey) return "intersect";
  if (e.shiftKey) return "add";
  if (e.altKey) return "subtract";
  return "replace";
}
