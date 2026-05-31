/**
 * Project (.aips) serialization.
 *
 * An .aips file is a JSON document capturing the full editable state: the
 * document size, the entire layer TREE (groups + children) with every layer's
 * params (adjustment params, text typography, layer effects, blend/opacity/
 * visible/clipping), masks, and the raster pixels of raster layers encoded as
 * base64 PNG data URLs. Text layers store their typographic params (and are
 * re-rasterized on load), so they stay editable. Group structure + the active
 * layer are preserved.
 *
 * Round-trips through the public Document + EditorEngine surface only (it never
 * touches GL): serialize reads `engine.doc`; deserialize clears + rebuilds the
 * document and asks the engine to drop its GPU caches.
 */
import type { EditorEngine, Guide, GridState } from "./EditorEngine";
import type { Path } from "./Paths";
import {
  isRasterLayer,
  isTextLayer,
  isAdjustmentLayer,
  isGroupLayer,
  isSmartLayer,
  type LayerId,
  type LayerEffects,
  type LayerMask,
  type BlendMode,
  type AdjustmentType,
  type AdjustmentParams,
  type TextLayerSnapshot,
  type SmartTransform,
} from "../model/Document";

/** Bump when the on-disk shape changes incompatibly. */
const AIPS_VERSION = 1;
const AIPS_MAGIC = "aips";

/** Serializable form of a layer mask (R8 buffer base64-encoded). */
interface SerMask {
  width: number;
  height: number;
  enabled: boolean;
  /** base64 of the raw R8 bytes (width*height). */
  data: string;
}

/** Common fields shared by every serialized node. */
interface SerBase {
  id: LayerId;
  name: string;
  visible: boolean;
  opacity: number;
  blendMode: BlendMode;
  parentId: LayerId | null;
  mask?: SerMask;
}

interface SerRaster extends SerBase {
  kind: "raster";
  x: number;
  y: number;
  width: number;
  height: number;
  clipping: boolean;
  effects?: LayerEffects;
  /** PNG data URL of the straight-alpha source pixels. */
  pixels: string;
}
interface SerText extends SerBase {
  kind: "text";
  x: number;
  y: number;
  clipping: boolean;
  effects?: LayerEffects;
  /** TextLayerSnapshot now carries pathId + warp, so they round-trip here. */
  text: TextLayerSnapshot;
}
interface SerSmart extends SerBase {
  kind: "smart";
  x: number;
  y: number;
  width: number;
  height: number;
  naturalWidth: number;
  naturalHeight: number;
  transform: SmartTransform;
  clipping: boolean;
  effects?: LayerEffects;
  /** PNG data URL of the IMMUTABLE original (straight-alpha) pixels. */
  pixels: string;
}
interface SerAdjustment extends SerBase {
  kind: "adjustment";
  adjustmentType: AdjustmentType;
  params: AdjustmentParams;
  clipping: boolean;
}
interface SerGroup extends SerBase {
  kind: "group";
  collapsed: boolean;
  childrenIds: LayerId[];
}
type SerNode = SerRaster | SerText | SerAdjustment | SerGroup | SerSmart;

interface AipsFile {
  magic: typeof AIPS_MAGIC;
  version: number;
  width: number;
  height: number;
  activeLayerId: LayerId | null;
  /** Document-root child ids, bottom -> top. */
  rootOrder: LayerId[];
  /** Every node, keyed by id (order is irrelevant; structure is in tree fields). */
  nodes: SerNode[];
  /** Vector paths (pen tool). Optional for backward compatibility. */
  paths?: Path[];
  /** Ruler guides (doc px). Optional. */
  guides?: Guide[];
  /** Grid config. Optional. */
  grid?: GridState;
  /** Ruler / snap visibility toggles. Optional. */
  rulersVisible?: boolean;
  snapEnabled?: boolean;
}

// ── base64 helpers ─────────────────────────────────────────
function bytesToBase64(bytes: Uint8Array): string {
  let bin = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    bin += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(bin);
}
function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

// ── canvas helpers (encode/decode pixels) ──────────────────
function makeCanvas(w: number, h: number): OffscreenCanvas | HTMLCanvasElement {
  if (typeof OffscreenCanvas !== "undefined") return new OffscreenCanvas(w, h);
  const cv = document.createElement("canvas");
  cv.width = w;
  cv.height = h;
  return cv;
}
function get2d(cv: OffscreenCanvas | HTMLCanvasElement): CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D {
  const ctx = cv.getContext("2d", { colorSpace: "srgb" }) as
    | CanvasRenderingContext2D
    | OffscreenCanvasRenderingContext2D
    | null;
  if (!ctx) throw new Error("2D context unavailable");
  return ctx;
}

/** Encode a layer source (ImageBitmap | ImageData) to a PNG data URL. */
async function sourceToPngDataUrl(src: ImageBitmap | ImageData): Promise<string> {
  const w = src.width;
  const h = src.height;
  const cv = makeCanvas(w, h);
  const ctx = get2d(cv);
  if (typeof ImageData !== "undefined" && src instanceof ImageData) {
    ctx.putImageData(src, 0, 0);
  } else {
    ctx.drawImage(src as ImageBitmap, 0, 0);
  }
  let blob: Blob;
  if (cv instanceof OffscreenCanvas) {
    blob = await cv.convertToBlob({ type: "image/png" });
  } else {
    blob = await new Promise<Blob>((res, rej) =>
      (cv as HTMLCanvasElement).toBlob((b) => (b ? res(b) : rej(new Error("toBlob failed"))), "image/png"),
    );
  }
  return await blobToDataUrl(blob);
}
function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(fr.result as string);
    fr.onerror = () => reject(fr.error);
    fr.readAsDataURL(blob);
  });
}

/** Decode a PNG data URL back to ImageData. */
async function dataUrlToImageData(dataUrl: string): Promise<ImageData> {
  const blob = await (await fetch(dataUrl)).blob();
  const bitmap = await createImageBitmap(blob, {
    premultiplyAlpha: "none",
    colorSpaceConversion: "none",
  });
  const cv = makeCanvas(bitmap.width, bitmap.height);
  const ctx = get2d(cv);
  ctx.drawImage(bitmap, 0, 0);
  const img = ctx.getImageData(0, 0, bitmap.width, bitmap.height);
  // Re-wrap so the typed array is plain ArrayBuffer-backed.
  return new ImageData(new Uint8ClampedArray(img.data), bitmap.width, bitmap.height);
}

function serMask(mask: LayerMask | undefined): SerMask | undefined {
  if (!mask) return undefined;
  return {
    width: mask.width,
    height: mask.height,
    enabled: mask.enabled,
    data: bytesToBase64(mask.data),
  };
}

// ── serialize ──────────────────────────────────────────────
/**
 * Serialize the engine's document to an .aips JSON Blob (application/json). The
 * returned Blob can be downloaded or stored; pass it back to
 * `deserializeDocument` to restore.
 */
export async function serializeDocument(engine: EditorEngine): Promise<Blob> {
  const doc = engine.doc;
  const nodes: SerNode[] = [];
  for (const id of doc.allLayerIds()) {
    const n = doc.getLayer(id);
    if (!n) continue;
    const base: SerBase = {
      id: n.id,
      name: n.name,
      visible: n.visible,
      opacity: n.opacity,
      blendMode: n.blendMode,
      parentId: (n as { parentId?: LayerId | null }).parentId ?? null,
      mask: serMask(n.mask),
    };
    if (isRasterLayer(n)) {
      nodes.push({
        ...base,
        kind: "raster",
        x: n.x,
        y: n.y,
        width: n.width,
        height: n.height,
        clipping: !!n.clipping,
        effects: n.effects ? structuredClone(n.effects) : undefined,
        pixels: await sourceToPngDataUrl(n.source),
      });
    } else if (isTextLayer(n)) {
      nodes.push({
        ...base,
        kind: "text",
        x: n.x,
        y: n.y,
        clipping: !!n.clipping,
        effects: n.effects ? structuredClone(n.effects) : undefined,
        text: {
          text: n.text,
          fontFamily: n.fontFamily,
          fontSize: n.fontSize,
          color: { ...n.color },
          align: n.align,
          bold: n.bold,
          italic: n.italic,
          lineHeight: n.lineHeight,
          pathId: n.pathId ?? null,
          warp: n.warp ? { ...n.warp } : undefined,
        },
      });
    } else if (isSmartLayer(n)) {
      nodes.push({
        ...base,
        kind: "smart",
        x: n.x,
        y: n.y,
        width: n.width,
        height: n.height,
        naturalWidth: n.naturalWidth,
        naturalHeight: n.naturalHeight,
        transform: { ...n.transform },
        clipping: !!n.clipping,
        effects: n.effects ? structuredClone(n.effects) : undefined,
        // The immutable original (naturalWidth×naturalHeight) — heavier than a
        // baked raster, but keeps the smart object non-destructive on reload.
        pixels: await sourceToPngDataUrl(n.source),
      });
    } else if (isAdjustmentLayer(n)) {
      nodes.push({
        ...base,
        kind: "adjustment",
        adjustmentType: n.adjustmentType,
        params: structuredClone(n.params),
        clipping: !!n.clipping,
      });
    } else if (isGroupLayer(n)) {
      nodes.push({
        ...base,
        kind: "group",
        collapsed: n.collapsed,
        childrenIds: n.childrenIds.slice(),
      });
    }
  }

  const extras = engine.serializeViewExtras();
  const file: AipsFile = {
    magic: AIPS_MAGIC,
    version: AIPS_VERSION,
    width: doc.width,
    height: doc.height,
    activeLayerId: doc.getActiveLayerId(),
    rootOrder: [...doc.orderBottomToTop()],
    nodes,
    paths: engine.serializePaths(),
    guides: extras.guides,
    grid: extras.grid,
    rulersVisible: extras.rulersVisible,
    snapEnabled: extras.snapEnabled,
  };
  return new Blob([JSON.stringify(file)], { type: "application/json" });
}

// ── deserialize ────────────────────────────────────────────
/**
 * Rebuild the engine's document from an .aips file (a Blob/File or a parsed
 * AipsFile object). Clears the current document, recreates every layer/group at
 * the root, restores params/effects/masks/clipping, then re-links the tree
 * structure and the active layer. Finally asks the engine to drop its GPU
 * caches so textures re-resolve.
 */
export async function deserializeDocument(
  engine: EditorEngine,
  input: Blob | File | string | AipsFile,
): Promise<void> {
  const file = await parseAips(input);
  const doc = engine.doc;
  doc.clear();
  doc.resize(file.width, file.height);

  // The remap from saved id -> newly-created id (Document mints fresh ids).
  const idMap = new Map<LayerId, LayerId>();
  const byNewId = new Map<LayerId, SerNode>();

  // 1) Create every node at the root (structure is fixed up afterwards).
  for (const sn of file.nodes) {
    let newId: LayerId;
    if (sn.kind === "raster") {
      const img = await dataUrlToImageData(sn.pixels);
      newId = doc.addRasterLayer(img, sn.name, { x: sn.x, y: sn.y });
    } else if (sn.kind === "text") {
      newId = doc.addTextLayer(sn.x, sn.y, {
        text: sn.text.text,
        fontFamily: sn.text.fontFamily,
        fontSize: sn.text.fontSize,
        color: sn.text.color,
        align: sn.text.align,
        bold: sn.text.bold,
        italic: sn.text.italic,
        lineHeight: sn.text.lineHeight,
      });
    } else if (sn.kind === "smart") {
      // Recreate as a raster of the original pixels, then wrap as a smart object
      // and restore the exact transform + footprint AABB.
      const img = await dataUrlToImageData(sn.pixels);
      newId = doc.addRasterLayer(img, sn.name, { x: sn.x, y: sn.y });
      doc.wrapAsSmartObject(newId, img, sn.x, sn.y);
      doc.setSmartTransform(newId, sn.transform, {
        x: sn.x,
        y: sn.y,
        width: sn.width,
        height: sn.height,
      });
    } else if (sn.kind === "adjustment") {
      newId = doc.addAdjustmentLayer(sn.adjustmentType, structuredClone(sn.params), sn.name);
    } else {
      newId = doc.addGroup(sn.name);
    }
    idMap.set(sn.id, newId);
    byNewId.set(newId, sn);
  }

  // 2) Apply per-node properties (common + kind-specific).
  for (const [newId, sn] of byNewId) {
    doc.setVisible(newId, sn.visible);
    doc.setOpacity(newId, sn.opacity);
    doc.setBlendMode(newId, sn.blendMode);
    doc.rename(newId, sn.name);
    if (
      sn.kind === "raster" ||
      sn.kind === "text" ||
      sn.kind === "adjustment" ||
      sn.kind === "smart"
    ) {
      doc.setClipping(newId, sn.clipping);
    }
    if ((sn.kind === "raster" || sn.kind === "text" || sn.kind === "smart") && sn.effects) {
      doc.setEffects(newId, structuredClone(sn.effects));
    }
    if (sn.kind === "text") {
      // pathId references a path restored later (step 5); the id is preserved as
      // saved (Paths keep their own ids — see deletePath/setPaths). warp is local.
      if (sn.text.pathId != null) doc.setTextPath(newId, sn.text.pathId);
      if (sn.text.warp) doc.setTextWarp(newId, sn.text.warp);
    }
    if (sn.mask) {
      doc.addMask(newId, base64ToBytes(sn.mask.data));
      doc.setMaskEnabled(newId, sn.mask.enabled);
    }
  }

  // 3) Re-link the tree structure (remap ids), then set the active layer.
  const remap = (id: LayerId | null): LayerId | null =>
    id === null ? null : idMap.get(id) ?? null;
  const groups: Record<LayerId, LayerId[]> = {};
  const parents: Record<LayerId, LayerId | null> = {};
  for (const [newId, sn] of byNewId) {
    parents[newId] = remap(sn.parentId);
    if (sn.kind === "group") {
      groups[newId] = sn.childrenIds.map((c) => remap(c)!).filter(Boolean) as LayerId[];
    }
  }
  const root = file.rootOrder.map((c) => remap(c)!).filter(Boolean) as LayerId[];
  doc.restoreStructure({ root, groups, parents });
  doc.setActive(remap(file.activeLayerId));

  // addRasterLayer() grows the document to fit each layer (Math.max), so a
  // raster extending past the saved bounds (e.g. a cropped doc, or a layer moved
  // partly off-canvas) would re-enlarge the document during rebuild. Re-pin the
  // saved size so the round-trip is exact.
  doc.resize(file.width, file.height);

  // 4) Drop GPU caches + resize the selection; re-render.
  engine.reloadAfterDeserialize();

  // 5) Restore vector paths + guides/grid/ruler-snap toggles (after reload,
  //    which clears them along with the old document).
  if (Array.isArray(file.paths)) engine.setPathsSerialized(file.paths);
  engine.setViewExtras({
    guides: file.guides,
    grid: file.grid,
    rulersVisible: file.rulersVisible,
    snapEnabled: file.snapEnabled,
  });
}

/** Coerce any accepted input into a validated AipsFile. */
async function parseAips(input: Blob | File | string | AipsFile): Promise<AipsFile> {
  let obj: unknown;
  if (typeof input === "string") {
    obj = JSON.parse(input);
  } else if (input instanceof Blob) {
    obj = JSON.parse(await input.text());
  } else {
    obj = input;
  }
  const f = obj as AipsFile;
  if (!f || f.magic !== AIPS_MAGIC || !Array.isArray(f.nodes)) {
    throw new Error("Not a valid .aips project file.");
  }
  return f;
}

export type { AipsFile };
