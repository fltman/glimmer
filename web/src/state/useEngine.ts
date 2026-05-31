/**
 * Singleton EditorEngine + React bindings.
 *
 * The engine is created once for the lifetime of the module so the GL context
 * and Document survive React re-renders/remounts. UI reads a serializable
 * snapshot via useSyncExternalStore and only ever mutates through engine
 * methods (it never touches pixels).
 */
import { useSyncExternalStore } from "react";
import { EditorEngine } from "../engine/EditorEngine";
import type {
  DocumentSnapshot,
  BlendMode,
  AdjustmentType,
  AdjustmentParams,
  TextLayerSnapshot,
  TextLayerPatch,
} from "../model/Document";
import {
  toolStore,
  type RGBAColor,
  type TextParams,
  type ShapeParams,
  type ShapeKind,
} from "./tools";
import type { GradientStop } from "../engine/adjustments";
import type { FilterType, FilterParams } from "../engine/filters";
import type { TransformState } from "../engine/EditorEngine";

export const engine = new EditorEngine();

export function useEngineSnapshot(): DocumentSnapshot {
  return useSyncExternalStore(
    (cb) => engine.subscribe(cb),
    () => engine.getSnapshot(),
    () => engine.getSnapshot(),
  );
}

/** Reactive history availability (undo/redo button enablement). */
export function useHistoryState(): { canUndo: boolean; canRedo: boolean } {
  const get = (): { canUndo: boolean; canRedo: boolean } => ({
    canUndo: engine.canUndo(),
    canRedo: engine.canRedo(),
  });
  // The engine emits on history change; recompute a stable-ish snapshot.
  return useSyncExternalStore(
    (cb) => engine.subscribe(cb),
    () => historyCacheFor(get()),
    () => historyCacheFor(get()),
  );
}

// Keep a referentially-stable object for useSyncExternalStore between equal reads.
let _historyCache = { canUndo: false, canRedo: false };
function historyCacheFor(next: { canUndo: boolean; canRedo: boolean }) {
  if (next.canUndo !== _historyCache.canUndo || next.canRedo !== _historyCache.canRedo) {
    _historyCache = next;
  }
  return _historyCache;
}

/** Reactive "is there a non-empty selection?" (drives inpaint enablement). */
export function useHasSelection(): boolean {
  return useSyncExternalStore(
    (cb) => engine.subscribe(cb),
    () => engine.hasSelection(),
    () => engine.hasSelection(),
  );
}

/** Reactive foreground/background color swatches (drives the color picker UI). */
export function useColors(): { foreground: RGBAColor; background: RGBAColor } {
  return useSyncExternalStore(
    (cb) => toolStore.subscribe(cb),
    () => {
      const ts = toolStore.get();
      return colorsCacheFor(ts.foreground, ts.background);
    },
    () => {
      const ts = toolStore.get();
      return colorsCacheFor(ts.foreground, ts.background);
    },
  );
}
let _colorsCache: { foreground: RGBAColor; background: RGBAColor } = {
  foreground: { r: 0, g: 0, b: 0, a: 1 },
  background: { r: 1, g: 1, b: 1, a: 1 },
};
function colorsCacheFor(fg: RGBAColor, bg: RGBAColor) {
  if (_colorsCache.foreground !== fg || _colorsCache.background !== bg) {
    _colorsCache = { foreground: fg, background: bg };
  }
  return _colorsCache;
}

// Thin action helpers so components don't reach into the engine directly.
export const actions = {
  toggleVisible(id: string, visible: boolean) {
    engine.doc.setVisible(id, visible);
  },
  /** Live opacity drag — no undo step per tick (the slider mutates directly). */
  setOpacity(id: string, opacity: number) {
    engine.doc.setOpacity(id, opacity);
  },
  /** Commit an opacity change as one undo step (on slider release). */
  commitOpacity(id: string, from: number, to: number) {
    engine.setLayerOpacityUndoable(id, from, to);
  },
  setBlendMode(id: string, mode: BlendMode) {
    engine.setLayerBlendModeUndoable(id, mode);
  },
  select(id: string) {
    engine.doc.setActive(id);
  },
  reorder(id: string, dir: number) {
    engine.doc.reorder(id, dir);
  },
  remove(id: string) {
    engine.doc.remove(id);
  },
  rename(id: string, name: string) {
    engine.doc.rename(id, name);
  },
  fit() {
    engine.fitToScreen();
  },
  // ── masks ──
  addMaskFromSelection(id: string) {
    engine.addLayerMaskFromSelection(id);
  },
  toggleMaskEnabled(id: string, enabled: boolean) {
    engine.doc.setMaskEnabled(id, enabled);
  },
  removeMask(id: string) {
    engine.doc.removeMask(id);
  },
  // ── selection ──
  selectAll() {
    engine.selectAll();
  },
  clearSelection() {
    engine.clearSelection();
  },
  // ── history ──
  undo() {
    engine.undo();
  },
  redo() {
    engine.redo();
  },

  // ── color (foreground/background) ──
  setForeground(c: RGBAColor) {
    toolStore.setForeground(c);
  },
  setBackground(c: RGBAColor) {
    toolStore.setBackground(c);
  },
  swapColors() {
    toolStore.swapColors();
  },
  resetColors() {
    toolStore.resetColors();
  },
  /** Sample the composited color at a document pixel (eyedropper). */
  sampleColorAt(docX: number, docY: number): RGBAColor {
    return engine.sampleColorAt(docX, docY);
  },

  // ── fill + gradient ──
  /** Fill the active layer's selection (or whole layer) with a color. */
  fillSelection(c: RGBAColor, layerId?: string) {
    engine.fillSelection(c, layerId);
  },
  applyGradientFill(
    layerId: string,
    opts: {
      type: "linear" | "radial";
      from: { x: number; y: number };
      to: { x: number; y: number };
      stops?: GradientStop[];
    },
  ) {
    engine.applyGradientFill(layerId, opts);
  },

  // ── adjustment layers ──
  addAdjustmentLayer(type: AdjustmentType, params?: AdjustmentParams) {
    return engine.addAdjustmentLayer(type, params);
  },
  /** Live param drag — no per-tick undo. */
  updateAdjustmentParams(id: string, patch: AdjustmentParams) {
    engine.updateAdjustmentParams(id, patch);
  },
  /** Commit a param edit as one undo step (on dialog OK / slider release). */
  commitAdjustmentParams(
    id: string,
    prev: AdjustmentParams,
    next: AdjustmentParams,
  ) {
    engine.commitAdjustmentParams(id, prev, next);
  },
  setAdjustmentClipping(id: string, clipping: boolean) {
    engine.setAdjustmentClipping(id, clipping);
  },

  // ── histogram ──
  getLayerHistogram(id: string) {
    return engine.getLayerHistogram(id);
  },

  // ── destructive filters ──
  applyFilter(layerId: string, type: FilterType, params?: FilterParams) {
    engine.applyFilter(layerId, type, params);
  },
  previewFilter(layerId: string, type: FilterType, params?: FilterParams) {
    engine.previewFilter(layerId, type, params);
  },
  commitFilter() {
    engine.commitFilter();
  },
  cancelFilter() {
    engine.cancelFilter();
  },

  // ── tool selection ──
  setActiveTool(tool: import("./tools").ToolId) {
    toolStore.setActive(tool);
  },

  // ── free transform ──
  /** Start a free-transform session on the active (or given) pixel layer. */
  beginTransform(layerId?: string) {
    engine.beginTransform(layerId);
  },
  /** Apply an explicit transform delta (UI escape hatch; pointer math is internal). */
  setTransform(patch: Partial<TransformState>) {
    engine.setTransform(patch);
  },
  /** Bake the live transform into the layer (one undo step). */
  commitTransform() {
    engine.commitTransform();
  },
  /** Discard the live transform. */
  cancelTransform() {
    engine.cancelTransform();
  },

  // ── crop ──
  beginCrop() {
    engine.beginCrop();
  },
  commitCrop() {
    engine.commitCrop();
  },
  cancelCrop() {
    engine.cancelCrop();
  },

  // ── text / type layers ──
  /** Create a text layer at a doc point and open it for editing. */
  addTextLayer(atDocX: number, atDocY: number, initialText = "") {
    return engine.addTextLayer(atDocX, atDocY, initialText);
  },
  /** Live-update a text layer's typographic params (re-rasterizes). */
  updateTextLayer(id: string, patch: TextLayerPatch) {
    engine.updateTextLayer(id, patch);
  },
  /** Record one undo step for a text edit (prev/next full param sets). */
  commitTextLayer(id: string, prev: TextLayerSnapshot, next: TextLayerSnapshot) {
    engine.commitTextLayer(id, prev, next);
  },
  /** Open the type editor for an existing text layer (double-click). */
  beginEditText(id: string) {
    engine.beginEditText(id);
  },
  /** Close the type editor overlay. */
  endEditText() {
    engine.endEditText();
  },
  /** Type-tool defaults for new text layers. */
  setTextParams(patch: Partial<TextParams>) {
    toolStore.setText(patch);
  },

  // ── shapes ──
  setShapeKind(kind: ShapeKind) {
    toolStore.setShapeKind(kind);
  },
  setShapeParams(patch: Partial<ShapeParams>) {
    toolStore.setShape(patch);
  },
};
