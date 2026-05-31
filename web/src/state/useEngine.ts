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
  LayerEffects,
  LayerEffectType,
} from "../model/Document";
import { exportImage, type ExportOptions } from "../engine/export";
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

/** Reactive history list (for a History panel): entries + current cursor. */
export function useHistoryEntries(): {
  entries: { label: string; index: number }[];
  currentIndex: number;
} {
  return useSyncExternalStore(
    (cb) => engine.subscribe(cb),
    () => historyEntriesCache(),
    () => historyEntriesCache(),
  );
}
let _historyEntriesCache: { entries: { label: string; index: number }[]; currentIndex: number } = {
  entries: [],
  currentIndex: 0,
};
function historyEntriesCache() {
  const h = engine.getHistory();
  const prev = _historyEntriesCache;
  // Cheap structural equality so useSyncExternalStore sees a stable ref.
  const same =
    prev.currentIndex === h.currentIndex &&
    prev.entries.length === h.entries.length &&
    prev.entries.every((e, i) => e.label === h.entries[i]?.label);
  if (!same) _historyEntriesCache = h;
  return _historyEntriesCache;
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
  /** Magic wand / select-by-color from a document seed point. */
  magicWandSelect(
    docX: number,
    docY: number,
    opts: {
      tolerance: number;
      contiguous: boolean;
      sampleAllLayers: boolean;
      op?: import("./tools").SelectionOp;
    },
  ) {
    engine.magicWandSelect(docX, docY, opts);
  },
  // ── selection refinement (Select menu) ──
  invertSelection() {
    engine.invertSelection();
  },
  expandSelection(px: number) {
    engine.expandSelection(px);
  },
  contractSelection(px: number) {
    engine.contractSelection(px);
  },
  featherSelection(px: number) {
    engine.featherSelection(px);
  },
  /** Turn a matte/alpha (e.g. RMBG cutout) into the selection (Select Subject). */
  setSelectionFromMask(source: ImageData | Uint8Array, feather?: number) {
    engine.setSelectionFromMask(source, feather);
  },

  // ── clone source (clone/heal cursor hint) ──
  setCloneSource(docX: number, docY: number) {
    engine.setCloneSource(docX, docY);
  },
  getCloneSource() {
    return engine.getCloneSource();
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
  /** Clip a layer (adjustment OR raster/text) to the layer directly below. */
  setClipping(id: string, clipping: boolean) {
    engine.setClipping(id, clipping);
  },

  // ── groups ──
  /** Create a new empty group at the top of the document. */
  addGroup(name?: string) {
    return engine.addGroup(name);
  },
  /** Wrap the given layers in a new group. Returns the group id (or null). */
  groupLayers(ids: string[], name?: string) {
    return engine.groupLayers(ids, name);
  },
  /** Dissolve a group, splicing its children back in place. */
  ungroup(groupId: string) {
    engine.ungroup(groupId);
  },
  /** Move a layer into a group at a child index (-1 = top). */
  moveLayerIntoGroup(id: string, groupId: string, index = -1) {
    engine.moveLayerIntoGroup(id, groupId, index);
  },
  /** Move a layer to the document root at an index (pull out of a group). */
  moveLayerToRoot(id: string, index = -1) {
    engine.moveLayerToRoot(id, index);
  },
  /** Collapse / expand a group's children rows (UI only). */
  setGroupCollapsed(id: string, collapsed: boolean) {
    engine.setGroupCollapsed(id, collapsed);
  },

  // ── layer styles / effects ──
  /** Live-update one named effect on a layer (no per-tick undo). */
  updateLayerEffect(id: string, type: LayerEffectType, patch: Record<string, unknown>) {
    engine.updateLayerEffect(id, type, patch);
  },
  /** Replace a layer's whole effects bag live (no undo). */
  setLayerEffects(id: string, effects: LayerEffects | undefined) {
    engine.setLayerEffects(id, effects);
  },
  /** Commit an effects edit as one undo step (prev/next full bags). */
  commitLayerEffects(id: string, prev: LayerEffects | undefined, next: LayerEffects | undefined) {
    engine.commitLayerEffects(id, prev, next);
  },
  /** Snapshot a copy of a layer's current effects (for undo bookkeeping). */
  getLayerEffects(id: string) {
    return engine.getLayerEffects(id);
  },

  // ── history list (History panel) ──
  getHistory() {
    return engine.getHistory();
  },
  /** Undo/redo to a specific history position (number of applied commands). */
  historyJumpTo(index: number) {
    engine.historyJumpTo(index);
  },

  // ── project save / load + image export ──
  /** Serialize the project to an .aips Blob. */
  saveProject() {
    return engine.saveProject();
  },
  /** Load a project from an .aips File/Blob/JSON (replaces the document). */
  loadProject(input: Blob | File | string) {
    return engine.loadProject(input);
  },
  /** Flatten + encode the document to an image Blob (png/jpeg/webp). */
  exportImage(opts: ExportOptions) {
    return exportImage(engine, opts);
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

  // ── magic wand + retouch tool params ──
  setMagicWandParams(patch: Partial<import("./tools").MagicWandParams>) {
    toolStore.setMagicWand(patch);
  },
  setCloneParams(patch: Partial<import("./tools").CloneParams>) {
    toolStore.setClone(patch);
  },
  setDodgeBurnParams(patch: Partial<import("./tools").DodgeBurnParams>) {
    toolStore.setDodgeBurn(patch);
  },
  setSmudgeParams(patch: Partial<import("./tools").SmudgeParams>) {
    toolStore.setSmudge(patch);
  },
  setFocusParams(patch: Partial<import("./tools").FocusParams>) {
    toolStore.setFocus(patch);
  },
};
