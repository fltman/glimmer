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
  swatchStore,
  brushPresetStore,
  patternStore,
  type RGBAColor,
  type TextParams,
  type ShapeParams,
  type ShapeKind,
  type GradientParams,
  type GradientStopUI,
  type SelectionOp,
  type BrushParams,
} from "./tools";
import type { LiquifyMode, LiquifyBrush } from "../engine/LiquifyEngine";
import type { GradientStop } from "../engine/adjustments";
import type { FilterType, FilterParams } from "../engine/filters";
import type {
  TransformState,
  Guide,
  GridState,
  SamUiPoint,
  LensBlurParams,
} from "../engine/EditorEngine";
import type { PathDescription, FillRule } from "../engine/Paths";

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

/** Reactive gradient-tool params (type + multi-stop ramp + reverse). */
export function useGradientParams(): GradientParams {
  return useSyncExternalStore(
    (cb) => toolStore.subscribe(cb),
    () => toolStore.get().gradient,
    () => toolStore.get().gradient,
  );
}

/**
 * Reactive guides + grid + ruler/snap toggles for the rulers/grid overlay and
 * the View menu. The engine emits on any change to these.
 */
export function useViewExtras(): {
  guides: Guide[];
  grid: GridState;
  rulersVisible: boolean;
  snapEnabled: boolean;
} {
  return useSyncExternalStore(
    (cb) => engine.subscribe(cb),
    () => viewExtrasCache(),
    () => viewExtrasCache(),
  );
}
let _viewExtrasCache: {
  guides: Guide[];
  grid: GridState;
  rulersVisible: boolean;
  snapEnabled: boolean;
} = {
  guides: [],
  grid: { visible: false, size: 64, subdivisions: 4 },
  rulersVisible: false,
  snapEnabled: true,
};
function viewExtrasCache() {
  const next = engine.serializeViewExtras();
  const prev = _viewExtrasCache;
  const guidesSame =
    prev.guides.length === next.guides.length &&
    prev.guides.every((g, i) => {
      const n = next.guides[i];
      return n && g.id === n.id && g.axis === n.axis && g.pos === n.pos;
    });
  const same =
    guidesSame &&
    prev.grid.visible === next.grid.visible &&
    prev.grid.size === next.grid.size &&
    prev.grid.subdivisions === next.grid.subdivisions &&
    prev.rulersVisible === next.rulersVisible &&
    prev.snapEnabled === next.snapEnabled;
  if (!same) _viewExtrasCache = next;
  return _viewExtrasCache;
}

/**
 * Reactive Liquify session state for the modal: whether a session is active, the
 * current warp mode, and the brush params. The engine emits on every change.
 */
export function useLiquifyState(): {
  active: boolean;
  mode: LiquifyMode;
  brush: LiquifyBrush;
} {
  return useSyncExternalStore(
    (cb) => engine.subscribe(cb),
    () => liquifyStateCache(),
    () => liquifyStateCache(),
  );
}
let _liquifyCache: { active: boolean; mode: LiquifyMode; brush: LiquifyBrush } = {
  active: false,
  mode: "forward_warp",
  brush: { size: 96, pressure: 1 },
};
function liquifyStateCache() {
  const active = engine.isLiquifying();
  const mode = engine.getLiquifyMode();
  const brush = engine.getLiquifyBrush();
  const prev = _liquifyCache;
  const same =
    prev.active === active &&
    prev.mode === mode &&
    prev.brush.size === brush.size &&
    prev.brush.pressure === brush.pressure;
  if (!same) _liquifyCache = { active, mode, brush };
  return _liquifyCache;
}

/**
 * Reactive SAM "select anything" session state for the UI: whether a session is
 * active, encode/decode readiness + busy, click points, candidate score, and
 * worker progress / error. The engine emits on every change.
 */
type SamUiState = {
  active: boolean;
  imageReady: boolean;
  busy: boolean;
  points: SamUiPoint[];
  hasCandidate: boolean;
  score: number;
  /** Coarse status label for the model-loading / running phases. */
  status: string | null;
  error: string | null;
};
export function useSamState(): SamUiState {
  return useSyncExternalStore(
    (cb) => engine.subscribe(cb),
    () => samStateCache(),
    () => samStateCache(),
  );
}
let _samCache: SamUiState = {
  active: false,
  imageReady: false,
  busy: false,
  points: [],
  hasCandidate: false,
  score: 0,
  status: null,
  error: null,
};
function samStateCache(): SamUiState {
  const s = engine.getSamState();
  const points = engine.getSamPoints();
  const next: SamUiState = s
    ? {
        active: true,
        imageReady: s.imageReady,
        busy: s.busy,
        points,
        hasCandidate: s.hasCandidate,
        score: s.score,
        status: s.progress
          ? s.progress.stage === "loading_model"
            ? "Loading model…"
            : s.progress.stage === "encoding"
              ? "Analyzing image…"
              : "Segmenting…"
          : null,
        error: s.error,
      }
    : { active: false, imageReady: false, busy: false, points: [], hasCandidate: false, score: 0, status: null, error: null };
  const prev = _samCache;
  const pointsSame =
    prev.points.length === next.points.length &&
    prev.points.every((p, i) => {
      const n = next.points[i];
      return n && p.x === n.x && p.y === n.y && p.positive === n.positive;
    });
  const same =
    prev.active === next.active &&
    prev.imageReady === next.imageReady &&
    prev.busy === next.busy &&
    prev.hasCandidate === next.hasCandidate &&
    prev.score === next.score &&
    prev.status === next.status &&
    prev.error === next.error &&
    pointsSame;
  if (!same) _samCache = next;
  return _samCache;
}

/**
 * Reactive AI Lens Blur session state for the UI: active, depth readiness,
 * live params (focus/amount/bokeh), and worker progress / error.
 */
type LensBlurUiState = {
  active: boolean;
  depthReady: boolean;
  params: LensBlurParams;
  status: string | null;
  error: string | null;
};
export function useLensBlurState(): LensBlurUiState {
  return useSyncExternalStore(
    (cb) => engine.subscribe(cb),
    () => lensBlurStateCache(),
    () => lensBlurStateCache(),
  );
}
let _lensBlurCache: LensBlurUiState = {
  active: false,
  depthReady: false,
  params: { focus: 0.5, amount: 0.5, bokeh: 0.4 },
  status: null,
  error: null,
};
function lensBlurStateCache(): LensBlurUiState {
  const s = engine.getLensBlurState();
  const next: LensBlurUiState = s
    ? {
        active: true,
        depthReady: s.depthReady,
        params: s.params,
        status: s.progress
          ? s.progress.stage === "loading_model"
            ? "Loading depth model…"
            : "Estimating depth…"
          : null,
        error: s.error,
      }
    : { active: false, depthReady: false, params: engine.getLensBlurParams(), status: null, error: null };
  const prev = _lensBlurCache;
  const same =
    prev.active === next.active &&
    prev.depthReady === next.depthReady &&
    prev.params.focus === next.params.focus &&
    prev.params.amount === next.params.amount &&
    prev.params.bokeh === next.params.bokeh &&
    prev.status === next.status &&
    prev.error === next.error;
  if (!same) _lensBlurCache = next;
  return _lensBlurCache;
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

  // ── patterns (fill + stamp) ──
  /**
   * Tile a pattern across the active layer's selection (or whole layer). Defaults
   * the pattern id / scale / opacity to the patternStore selection.
   */
  fillWithPattern(
    layerId: string,
    patternId?: string,
    opts?: { scale?: number; opacity?: number },
  ) {
    engine.fillWithPattern(layerId, patternId ?? patternStore.getState().selectedId, opts);
  },
  /** Select the active pattern (pattern-stamp tool + fillWithPattern default). */
  setPattern(id: string) {
    patternStore.setSelected(id);
  },
  /** Set the pattern tile scale multiplier (1 = native tile size). */
  setPatternScale(scale: number) {
    patternStore.setScale(scale);
  },
  /** Set the pattern fill/stamp opacity 0..1. */
  setPatternOpacity(opacity: number) {
    patternStore.setOpacity(opacity);
  },

  // ── content-aware fill helpers (UI runs the AI inpaint(mode:'remove') job) ──
  /** Active layer id if it's a raster layer, else null (gates content-aware fill). */
  getActiveRasterLayerId(): string | null {
    return engine.getActiveRasterLayerId();
  },
  /** Tight doc-space ROI of the current selection (the region to regenerate). */
  getSelectionMaskBounds() {
    return engine.getSelectionMaskBounds();
  },
  /** PNG of a layer's composited pixels within an ROI (the source to inpaint). */
  exportLayerRegionPNG(
    layerId: string,
    roi: { x: number; y: number; width: number; height: number },
  ) {
    return engine.exportLayerRegionPNG(layerId, roi);
  },
  /** PNG of the selection mask (white = remove) within an ROI. */
  exportSelectionMaskPNG(roi?: { x: number; y: number; width: number; height: number }) {
    return engine.exportSelectionMaskPNG(roi);
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

  // ── gradient tool (multi-stop) ──
  /** Patch gradient params (type / reverse / stops). */
  setGradient(patch: Partial<GradientParams>) {
    toolStore.setGradient(patch);
  },
  /** Replace the gradient stop ramp. */
  setGradientStops(stops: GradientStopUI[]) {
    toolStore.setGradientStops(stops);
  },

  // ── swatches ──
  addSwatch(color: RGBAColor) {
    swatchStore.add(color);
  },
  removeSwatch(index: number) {
    swatchStore.removeAt(index);
  },
  resetSwatches() {
    swatchStore.reset();
  },

  // ── brush params + dynamics + presets ──
  /** Patch the live brush params (size/opacity/hardness/flow + dynamics). */
  setBrushParams(patch: Partial<BrushParams>) {
    toolStore.setBrush(patch);
  },
  /** Apply a brush preset's params to the live brush. */
  applyBrushPreset(id: string) {
    brushPresetStore.apply(id);
  },
  /** Save the current brush params as a new user preset. Returns its id. */
  addBrushPreset(name: string) {
    return brushPresetStore.add(name);
  },
  /** Remove a user brush preset (built-ins are protected). */
  removeBrushPreset(id: string) {
    brushPresetStore.remove(id);
  },

  // ── liquify (modal warp session) ──
  /** Begin a Liquify session on the active (or given) raster layer. */
  beginLiquify(layerId?: string) {
    return engine.beginLiquify(layerId);
  },
  /** Whether a Liquify session is currently active (drives the modal). */
  isLiquifying() {
    return engine.isLiquifying();
  },
  /** The active Liquify warp mode. */
  getLiquifyMode() {
    return engine.getLiquifyMode();
  },
  setLiquifyMode(mode: LiquifyMode) {
    engine.setLiquifyMode(mode);
  },
  /** The active Liquify brush params (size/pressure). */
  getLiquifyBrush() {
    return engine.getLiquifyBrush();
  },
  setLiquifyBrush(patch: Partial<LiquifyBrush>) {
    engine.setLiquifyBrush(patch);
  },
  /** Apply one Liquify dab at a doc point with a doc-px motion vector. */
  liquifyDab(
    docX: number,
    docY: number,
    dx: number,
    dy: number,
    mode?: LiquifyMode,
    size?: number,
    pressure?: number,
  ) {
    engine.liquifyDab(docX, docY, dx, dy, mode, size, pressure);
  },
  /** Relax the whole displacement map toward identity (modal "Restore All"). */
  liquifyReconstructAll(amount?: number) {
    engine.liquifyReconstructAll(amount);
  },
  /** Bake the warp into the layer as one undo step and end the session. */
  commitLiquify() {
    engine.commitLiquify();
  },
  /** Discard the Liquify session (the layer is unchanged). */
  cancelLiquify() {
    engine.cancelLiquify();
  },

  // ── SAM: click-to-select-anything (client-ML, worker) ──
  /** Begin a SAM session on the active (or given) raster layer (encodes once). */
  samBeginOnActiveLayer(layerId?: string) {
    return engine.samBeginOnActiveLayer(layerId);
  },
  /** Add a SAM prompt point at a doc point (positive = include, false = exclude). */
  samAddPoint(docX: number, docY: number, positive: boolean) {
    engine.samAddPoint(docX, docY, positive);
  },
  /** Remove the last SAM prompt point and re-run the decoder. */
  samRemoveLastPoint() {
    engine.samRemoveLastPoint();
  },
  /** Drop all SAM points + candidate without re-encoding the image (instant). */
  samClearPoints() {
    engine.samClearPoints();
  },
  /** Current SAM candidate as layer-sized ImageData (alpha = mask), or null. */
  samPreviewMask() {
    return engine.samPreviewMask();
  },
  /** Commit the SAM candidate into the selection via a boolean op (default replace). */
  samCommit(op?: SelectionOp) {
    engine.samCommit(op);
  },
  /** Discard the SAM session (selection unchanged). */
  samCancel() {
    engine.samCancel();
  },
  /** Whether a SAM session is active (drives the SAM panel). */
  isSamActive() {
    return engine.isSamActive();
  },
  /** The SAM click points so far (doc px + polarity). */
  getSamPoints() {
    return engine.getSamPoints();
  },

  // ── AI Lens Blur (depth-aware bokeh; client-ML depth, worker) ──
  /** Compute (or reuse cached) the depth map for the active/given raster layer. */
  computeDepth(layerId?: string) {
    return engine.computeDepth(layerId);
  },
  /** Depth map of a layer as a grayscale PNG (near = bright), for a depth view. */
  getDepthPreview(layerId?: string) {
    return engine.getDepthPreview(layerId);
  },
  /** Begin an AI Lens Blur session on the active (or given) raster layer. */
  beginLensBlur(layerId?: string) {
    return engine.beginLensBlur(layerId);
  },
  /** Whether an AI Lens Blur session is active (drives the panel). */
  isLensBlurActive() {
    return engine.isLensBlurActive();
  },
  /** Live AI Lens Blur params (focus/amount/bokeh). */
  getLensBlurParams() {
    return engine.getLensBlurParams();
  },
  /** Live-update AI Lens Blur params (re-renders the preview). */
  setLensBlurParams(patch: Partial<LensBlurParams>) {
    engine.setLensBlurParams(patch);
  },
  /** Commit the AI Lens Blur as one undo step (RGBA8 readback → replaceSource). */
  commitLensBlur() {
    engine.commitLensBlur();
  },
  /** Discard the AI Lens Blur session (the layer is unchanged). */
  cancelLensBlur() {
    engine.cancelLensBlur();
  },

  // ── pen tool / vector paths ──
  /** The live (in-progress) or active committed path, in doc px (overlay). */
  getActivePath(): PathDescription | null {
    return engine.getActivePath();
  },
  /** All committed paths in doc px. */
  getPaths(): PathDescription[] {
    return engine.getPaths();
  },
  /** Rasterize a closed path into the selection. */
  makePathSelection(pathId?: string, op?: SelectionOp, rule?: FillRule) {
    engine.makePathSelection(pathId, op, rule);
  },
  /** Fill a closed path on the active raster layer (foreground default). */
  fillPath(pathId?: string, color?: RGBAColor, rule?: FillRule) {
    engine.fillPath(pathId, color, rule);
  },
  /** Stroke a path's outline on the active raster layer. */
  strokePath(pathId?: string, opts?: { width?: number; color?: RGBAColor }) {
    engine.strokePath(pathId, opts);
  },
  /** Delete a path (or the active path). */
  deletePath(pathId?: string) {
    engine.deletePath(pathId);
  },
  /** Discard the in-progress live path. */
  clearActivePath() {
    engine.clearActivePath();
  },

  // ── rulers / guides / grid / snapping ──
  addGuide(axis: "h" | "v", pos: number) {
    return engine.addGuide(axis, pos);
  },
  removeGuide(id: string) {
    engine.removeGuide(id);
  },
  moveGuide(id: string, pos: number) {
    engine.moveGuide(id, pos);
  },
  getGuides() {
    return engine.getGuides();
  },
  clearGuides() {
    engine.clearGuides();
  },
  /** Begin dragging a new guide off a ruler (axis = guide orientation). */
  beginGuideDrag(axis: "h" | "v", screenX: number, screenY: number) {
    engine.beginGuideDrag(axis, screenX, screenY);
  },
  updateGuideDrag(screenX: number, screenY: number) {
    engine.updateGuideDrag(screenX, screenY);
  },
  endGuideDrag() {
    return engine.endGuideDrag();
  },
  getLiveGuide() {
    return engine.getLiveGuide();
  },
  setGridVisible(visible: boolean) {
    engine.setGridVisible(visible);
  },
  setGridSize(size: number, subdivisions?: number) {
    engine.setGridSize(size, subdivisions);
  },
  getGrid() {
    return engine.getGrid();
  },
  setRulersVisible(visible: boolean) {
    engine.setRulersVisible(visible);
  },
  setSnapEnabled(enabled: boolean) {
    engine.setSnapEnabled(enabled);
  },
  /** Snap a doc-space point (UI escape hatch; gestures snap internally). */
  snapPointDoc(p: { x: number; y: number }, thresholdScreenPx?: number) {
    return engine.snapPointDoc(p, thresholdScreenPx);
  },
};
