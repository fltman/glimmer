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
import type { DocumentSnapshot, BlendMode } from "../model/Document";

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
};
