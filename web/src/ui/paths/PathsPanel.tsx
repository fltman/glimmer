/**
 * Paths panel — a Photoshop-style list of the document's vector paths.
 *
 * Reads the engine's committed paths reactively and lets you pick the active
 * path, rename it, delete it, and run the pen ops on the selected path:
 *   - Make Selection (rasterizes the closed region into the selection),
 *   - Fill (fills the closed region with the foreground on the active layer),
 *   - Stroke (strokes every subpath onto the active layer).
 *
 * The engine exposes paths as plain getters (`engine.getPaths()` /
 * `engine.getActivePath()`) and emits on every path mutation (the same emitter
 * `useEngineSnapshot` subscribes to). We bind to that emitter with
 * `useSyncExternalStore` and re-read the path list, keeping a referentially
 * stable cache so React doesn't loop. Pure UI — every mutation goes through the
 * engine `actions.*` API; React never touches pixels.
 *
 * NOTE on rename: the engine does not expose a path-rename mutation, so the
 * display name override lives here as UI state keyed by path id. The path ops
 * always address the real engine path by id, so renaming is purely cosmetic and
 * never affects selection/fill/stroke targeting.
 */
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { PenTool } from "lucide-react";
import { engine, actions, useColors } from "../../state/useEngine";
import { EmptyState } from "../EmptyState";
import type { PathDescription } from "../../engine/Paths";
import { rgbCss } from "../color/colorMath";

/* ── reactive committed-path list (engine emits on path changes) ───────────── */

// A referentially-stable cache so useSyncExternalStore sees a stable ref when
// the path list is structurally unchanged (avoids an update loop).
let _pathsCache: PathDescription[] = [];
function pathsSnapshot(): PathDescription[] {
  const next = engine.getPaths();
  const prev = _pathsCache;
  const same =
    prev.length === next.length &&
    prev.every((p, i) => {
      const n = next[i];
      return (
        n &&
        p.id === n.id &&
        p.name === n.name &&
        p.subpaths.length === n.subpaths.length &&
        p.subpaths.every((sp, j) => {
          const nsp = n.subpaths[j];
          return nsp && sp.closed === nsp.closed && sp.anchors.length === nsp.anchors.length;
        })
      );
    });
  if (!same) _pathsCache = next;
  return _pathsCache;
}
function usePaths(): PathDescription[] {
  return useSyncExternalStore(
    (cb) => engine.subscribe(cb),
    pathsSnapshot,
    pathsSnapshot,
  );
}

/* ── icons ─────────────────────────────────────────────────────────────────── */

/** Tiny pen-nib glyph for each path row. */
function PathIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M4 20c8 0 10-4 10-10" />
      <path d="M14 10 17 4l3 3-6 3Z" />
      <circle cx="4.5" cy="19.5" r="1.2" fill="currentColor" stroke="none" />
    </svg>
  );
}

/** A little thumbnail tracing the path's outline, scaled into a square. */
function PathThumb({ path }: { path: PathDescription }) {
  const box = pathBBox(path);
  // Map the path's bbox into a 0..24 viewBox with a small inset.
  const inset = 3;
  const span = 24 - inset * 2;
  const w = Math.max(box.w, 1);
  const h = Math.max(box.h, 1);
  const s = Math.min(span / w, span / h);
  const ox = inset + (span - w * s) / 2 - box.x * s;
  const oy = inset + (span - h * s) / 2 - box.y * s;
  const map = (x: number, y: number) => `${(x * s + ox).toFixed(2)} ${(y * s + oy).toFixed(2)}`;

  let d = "";
  for (const sp of path.subpaths) {
    const a = sp.anchors;
    if (a.length === 0) continue;
    d += `M ${map(a[0]!.x, a[0]!.y)} `;
    for (let i = 1; i < a.length; i++) {
      const p0 = a[i - 1]!;
      const p1 = a[i]!;
      d += `C ${map(p0.outX, p0.outY)} ${map(p1.inX, p1.inY)} ${map(p1.x, p1.y)} `;
    }
    if (sp.closed && a.length > 1) {
      const p0 = a[a.length - 1]!;
      const p1 = a[0]!;
      d += `C ${map(p0.outX, p0.outY)} ${map(p1.inX, p1.inY)} ${map(p1.x, p1.y)} Z `;
    }
  }

  return (
    <svg width="22" height="22" viewBox="0 0 24 24" className="shrink-0 rounded-[2px] border border-edge bg-panelraised" aria-hidden>
      <path d={d} fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" strokeLinecap="round" />
    </svg>
  );
}

function pathBBox(path: PathDescription): { x: number; y: number; w: number; h: number } {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const sp of path.subpaths) {
    for (const a of sp.anchors) {
      for (const [x, y] of [
        [a.x, a.y],
        [a.inX, a.inY],
        [a.outX, a.outY],
      ] as const) {
        if (x < minX) minX = x;
        if (y < minY) minY = y;
        if (x > maxX) maxX = x;
        if (y > maxY) maxY = y;
      }
    }
  }
  if (!Number.isFinite(minX)) return { x: 0, y: 0, w: 1, h: 1 };
  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
}

/** Does the path have at least one closed subpath (fill/selection are valid)? */
function hasClosedRegion(path: PathDescription): boolean {
  return path.subpaths.some((sp) => sp.closed && sp.anchors.length >= 2);
}

/* ── panel ─────────────────────────────────────────────────────────────────── */

export function PathsPanel() {
  const paths = usePaths();
  const { foreground } = useColors();
  const drawing = engine.isDrawingPath();

  // UI-selected path id (the row the ops act on). Defaults to the engine's
  // active path (last committed); falls back to the first existing path.
  const [selectedId, setSelectedId] = useState<string | null>(null);
  // Local cosmetic rename overrides (engine has no path-rename mutation).
  const [nameOverrides, setNameOverrides] = useState<Record<string, string>>({});
  const [editingId, setEditingId] = useState<string | null>(null);
  const [strokeWidth, setStrokeWidth] = useState(2);

  // Keep the selection valid as paths come and go: if the selected path is gone
  // (or none is chosen), fall back to the engine's active path or the first row.
  useEffect(() => {
    const exists = selectedId && paths.some((p) => p.id === selectedId);
    if (exists) return;
    const activeId = engine.getActivePath()?.id ?? null;
    const fallback =
      (activeId && paths.some((p) => p.id === activeId) ? activeId : null) ??
      paths[0]?.id ??
      null;
    setSelectedId(fallback);
  }, [paths, selectedId]);

  const selected = paths.find((p) => p.id === selectedId) ?? null;
  const canFill = !!selected && hasClosedRegion(selected);

  const displayName = (p: PathDescription) => nameOverrides[p.id] ?? p.name;

  const commitRename = (id: string, value: string) => {
    const v = value.trim();
    setNameOverrides((m) => {
      const next = { ...m };
      // Empty input restores the engine name (drop the override).
      const original = paths.find((p) => p.id === id)?.name ?? "";
      if (!v || v === original) delete next[id];
      else next[id] = v;
      return next;
    });
    setEditingId(null);
  };

  return (
    <div className="flex h-full flex-col">
      <div className="panel-title flex items-center justify-between border-b border-edge">
        <span>Paths</span>
        {drawing && (
          <span className="text-[10px] font-normal normal-case tracking-normal text-accent">
            drawing… Enter to finish
          </span>
        )}
      </div>

      {/* Path list */}
      <div className="min-h-0 flex-1 overflow-y-auto">
        {paths.map((p) => {
          const isSel = p.id === selectedId;
          return (
            <div
              key={p.id}
              onClick={() => setSelectedId(p.id)}
              onDoubleClick={() => setEditingId(p.id)}
              className={`group flex w-full cursor-pointer items-center gap-2 border-b border-edge/60 px-3 py-2 text-left text-sm transition-colors ${
                isSel ? "bg-accent/15 text-ink" : "text-ink hover:bg-panelraised"
              }`}
            >
              <span className={isSel ? "text-accent" : "text-muted"}>
                <PathIcon />
              </span>
              <PathThumb path={p} />
              {editingId === p.id ? (
                <RenameInput
                  initial={displayName(p)}
                  onCommit={(v) => commitRename(p.id, v)}
                  onCancel={() => setEditingId(null)}
                />
              ) : (
                <span className="flex-1 truncate" title={displayName(p)}>
                  {displayName(p)}
                  {!hasClosedRegion(p) && (
                    <span className="ml-1 text-[10px] text-muted">(open)</span>
                  )}
                </span>
              )}
              <button
                type="button"
                title="Delete path"
                onClick={(e) => {
                  e.stopPropagation();
                  actions.deletePath(p.id);
                  if (selectedId === p.id) setSelectedId(null);
                }}
                className="flex h-5 w-5 shrink-0 items-center justify-center rounded text-muted opacity-0 transition-opacity hover:bg-panel hover:text-ink group-hover:opacity-100"
              >
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                  <path d="M6 6 18 18M18 6 6 18" />
                </svg>
              </button>
            </div>
          );
        })}

        {paths.length === 0 && (
          <EmptyState
            icon={PenTool}
            title="No paths yet"
            hint="Draw with the Pen tool — click for anchors, drag for curves, click the first anchor to close."
          />
        )}
      </div>

      {/* Ops for the selected path */}
      <div className="shrink-0 border-t border-edge px-3 py-3">
        <div className="mb-2 flex items-center gap-2 text-[11px] text-muted">
          <span className="uppercase tracking-wider">Active path</span>
          <span className="flex-1 truncate text-ink" title={selected ? displayName(selected) : ""}>
            {selected ? displayName(selected) : "—"}
          </span>
        </div>

        <div className="grid grid-cols-3 gap-1.5">
          <OpButton
            label="Selection"
            title="Make a selection from the path's closed region"
            disabled={!canFill}
            onClick={() => selected && actions.makePathSelection(selected.id, "replace")}
          />
          <OpButton
            label="Fill"
            title="Fill the closed region with the foreground color (active layer)"
            disabled={!canFill}
            swatch={rgbCss(foreground)}
            onClick={() => selected && actions.fillPath(selected.id, foreground)}
          />
          <OpButton
            label="Stroke"
            title="Stroke the path outline with the foreground color (active layer)"
            disabled={!selected}
            swatch={rgbCss(foreground)}
            onClick={() =>
              selected &&
              actions.strokePath(selected.id, { width: strokeWidth, color: foreground })
            }
          />
        </div>

        {/* Stroke width control */}
        <label className="mt-2.5 flex items-center gap-2 text-[11px] text-muted">
          <span className="w-14 shrink-0 uppercase tracking-wider">Stroke</span>
          <input
            type="range"
            min={0.5}
            max={40}
            step={0.5}
            value={strokeWidth}
            onChange={(e) => setStrokeWidth(Number(e.target.value))}
            className="h-1 flex-1 accent-accent"
          />
          <span className="w-10 shrink-0 text-right tabular-nums text-ink">
            {strokeWidth} px
          </span>
        </label>

        {!canFill && selected && (
          <p className="mt-2 text-[10px] leading-snug text-muted">
            This path has no closed region — only Stroke is available. Close a
            subpath with the Pen tool to fill or select it.
          </p>
        )}
      </div>
    </div>
  );
}

/** Inline rename field; commits on blur/Enter, cancels on Escape. */
function RenameInput({
  initial,
  onCommit,
  onCancel,
}: {
  initial: string;
  onCommit: (value: string) => void;
  onCancel: () => void;
}) {
  const ref = useRef<HTMLInputElement | null>(null);
  useEffect(() => {
    ref.current?.focus();
    ref.current?.select();
  }, []);
  return (
    <input
      ref={ref}
      defaultValue={initial}
      onClick={(e) => e.stopPropagation()}
      onBlur={(e) => onCommit(e.currentTarget.value)}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          onCommit(e.currentTarget.value);
        } else if (e.key === "Escape") {
          e.preventDefault();
          onCancel();
        }
      }}
      className="flex-1 rounded border border-accent bg-panel px-1.5 py-0.5 text-sm text-ink outline-none"
    />
  );
}

/** A compact op button with an optional foreground-color swatch. */
function OpButton({
  label,
  title,
  disabled,
  swatch,
  onClick,
}: {
  label: string;
  title: string;
  disabled?: boolean;
  swatch?: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      title={title}
      disabled={disabled}
      onClick={onClick}
      className={`flex items-center justify-center gap-1.5 rounded border border-edge px-2 py-1.5 text-xs font-medium transition-colors ${
        disabled
          ? "cursor-not-allowed text-muted/40"
          : "text-ink hover:border-accent hover:bg-panelraised"
      }`}
    >
      {swatch && (
        <span
          className="h-2.5 w-2.5 rounded-[2px] border border-black/40"
          style={{ background: swatch }}
        />
      )}
      {label}
    </button>
  );
}
