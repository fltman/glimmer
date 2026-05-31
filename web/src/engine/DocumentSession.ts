/**
 * DocumentSession — the per-document state bundle for multi-document support.
 *
 * The EditorEngine owns ONE canvas + ONE GL context + ONE Renderer (+ the
 * shared shader programs, viewport accumulators, BrushEngine/RetouchEngine/
 * LiquifyEngine, and the single Selection object). Everything that is logically
 * *per open document* — the layer tree, undo/redo history, vector paths, view
 * transform, channel visibility, rulers/guides/grid, and the CPU-side text
 * raster caches — lives in a DocumentSession.
 *
 * Switching documents re-points the engine's `doc`/`history`/`paths` fields at
 * the active session's instances and restores the rest of the per-doc state;
 * the SHARED GL objects are never swapped. The selection mask is carried across
 * switches as a doc-sized R8 byte buffer (`selectionBuffer`) rather than as a
 * resident GL framebuffer, so closing/switching many documents never leaks GPU
 * memory.
 *
 * NB: this is a plain data bundle — it never touches GL itself.
 */
import type { Document } from "../model/Document";
import type { LayerId } from "../model/Document";
import type { History } from "./history/History";
import type { PathStore } from "./Paths";
import type { ChannelVisibility, Guide, GridState } from "./EditorEngine";

/** Plain serializable view transform (pan/zoom/rotate); no GL. */
export interface SessionView {
  scale: number;
  tx: number;
  ty: number;
  rot: number;
}

/**
 * The full per-document state. One instance exists per open document; the
 * active one's `doc`/`history`/`paths` are what `engine.doc`/`.history`/`.paths`
 * point at. `view`/`channelVis`/guides/grid and the text caches are restored
 * onto the engine's own fields on switch.
 */
export interface DocumentSession {
  /** Session id (NOT a layer id), e.g. `doc_1`. Stable for the tab bar. */
  readonly id: string;
  /** Tab label — defaults to "Untitled", or a file name on open. */
  title: string;

  // ── CPU-authoritative model + history + paths (swapped on switch) ──
  doc: Document;
  history: History;
  paths: PathStore;

  // ── per-doc UI / view state (restored onto engine fields on switch) ──
  view: SessionView;
  channelVis: ChannelVisibility;
  guides: Guide[];
  guideSeq: number;
  grid: GridState;
  rulersVisible: boolean;
  snapEnabled: boolean;

  /**
   * The selection mask carried across switches as a doc-sized R8 byte buffer
   * (top-down, row 0 = doc top), or null for an empty selection. The single
   * shared Selection object is re-seeded from this on switch.
   */
  selectionBuffer: Uint8Array | null;

  // ── CPU text-raster caches (per doc) ──
  textRasterVersion: Map<LayerId, string>;
  flatTextPos: Map<LayerId, { x: number; y: number }>;

  /** Whether this doc's view has been fit-to-screen once (first content load). */
  fitted: boolean;
}

/** A doc-list entry for the tab bar / documents snapshot. */
export interface DocumentListEntry {
  id: string;
  name: string;
  width: number;
  height: number;
  active: boolean;
}

/** The full documents snapshot the UI reads via useSyncExternalStore. */
export interface DocumentsSnapshot {
  documents: DocumentListEntry[];
  activeDocId: string | null;
}
