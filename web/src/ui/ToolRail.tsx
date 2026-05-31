/**
 * Left tool rail — selects the active tool in the tool store. Pure UI: it reads
 * and writes only `toolStore`; the engine reads the same store when routing
 * pointer events. Dark-themed to match the existing chrome.
 *
 * The Transform and Crop tools also kick off an engine session when selected
 * (begin*); selecting them is the canonical "enter free-transform / crop" entry
 * point. The Shape tool carries a flyout to pick the active shape primitive
 * (rect / ellipse / line) without leaving the rail.
 */
import { Fragment, useEffect, useRef, useState } from "react";
import {
  toolStore,
  useToolState,
  type ToolId,
  type ShapeKind,
} from "../state/tools";
import { actions } from "../state/useEngine";
import { ColorControls } from "./color";

interface ToolDef {
  id: ToolId;
  glyph: string;
  label: string;
  /** Single-key shortcut (shown in the tooltip; bound in App). */
  key: string;
  /** Tools sharing a group are kept together; a divider falls between groups. */
  group: number;
}

export const TOOLS: ToolDef[] = [
  { id: "move", glyph: "✥", label: "Move", key: "V", group: 0 },
  { id: "marquee-rect", glyph: "▭", label: "Rectangle marquee", key: "M", group: 1 },
  { id: "marquee-ellipse", glyph: "◯", label: "Ellipse marquee", key: "M", group: 1 },
  { id: "lasso", glyph: "✑", label: "Lasso", key: "L", group: 1 },
  { id: "crop", glyph: "⌗", label: "Crop", key: "C", group: 2 },
  { id: "transform", glyph: "⤢", label: "Free transform", key: "T", group: 2 },
  { id: "brush", glyph: "🖌", label: "Brush", key: "B", group: 3 },
  { id: "eraser", glyph: "⌫", label: "Eraser", key: "E", group: 3 },
  { id: "bucket", glyph: "🪣", label: "Paint bucket", key: "K", group: 3 },
  { id: "gradient", glyph: "🌈", label: "Gradient", key: "G", group: 3 },
  { id: "text", glyph: "T", label: "Type", key: "Y", group: 4 },
  // Shape lives in the rail too, but its glyph + flyout are handled specially.
  { id: "shape", glyph: "▱", label: "Shape", key: "U", group: 4 },
  { id: "eyedropper", glyph: "💧", label: "Eyedropper", key: "I", group: 5 },
  { id: "hand", glyph: "✋", label: "Hand (pan)", key: "H", group: 5 },
];

/** Per-shape glyphs for the shape-tool button + its flyout. */
const SHAPE_GLYPH: Record<ShapeKind, string> = {
  rect: "▱",
  ellipse: "◯",
  line: "╱",
};
const SHAPE_LABEL: Record<ShapeKind, string> = {
  rect: "Rectangle",
  ellipse: "Ellipse",
  line: "Line",
};
const SHAPE_ORDER: ShapeKind[] = ["rect", "ellipse", "line"];

/**
 * Dispatch a tool selection. Transform/Crop additionally open an engine session
 * (the engine's begin* also switches the active tool, but calling setActive
 * first keeps the rail highlight immediate). Everything else is a plain store
 * write that the engine reads when routing pointer events.
 */
function selectTool(id: ToolId): void {
  if (id === "transform") {
    actions.setActiveTool("transform");
    actions.beginTransform();
    return;
  }
  if (id === "crop") {
    actions.setActiveTool("crop");
    actions.beginCrop();
    return;
  }
  toolStore.setActive(id);
}

/** The shape button: shows the active shapeKind glyph and a flyout to switch. */
function ShapeButton({ selected }: { selected: boolean }) {
  const { shape } = useToolState();
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);

  // Close the flyout on outside click / Escape.
  useEffect(() => {
    if (!open) return;
    function onDown(e: PointerEvent) {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    window.addEventListener("pointerdown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("pointerdown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div ref={rootRef} className="relative">
      <button
        onClick={() => {
          toolStore.setActive("shape");
          setOpen((o) => !o);
        }}
        className={`relative flex h-9 w-9 items-center justify-center rounded-md text-base transition-colors ${
          selected
            ? "bg-accent/20 text-ink ring-1 ring-accent/60"
            : "text-muted hover:bg-panelraised hover:text-ink"
        }`}
        title={`Shape — ${SHAPE_LABEL[shape.kind]} (U) · click for more`}
      >
        {SHAPE_GLYPH[shape.kind]}
        {/* Flyout affordance: a little corner tick like Photoshop's tool groups. */}
        <span className="absolute bottom-0.5 right-0.5 h-0 w-0 border-b-[4px] border-l-[4px] border-b-muted border-l-transparent" />
      </button>

      {open && (
        <div
          className="absolute left-full top-0 z-50 ml-1 flex gap-1 rounded-md border border-edge bg-panelraised p-1 shadow-lg"
          onPointerDown={(e) => e.stopPropagation()}
        >
          {SHAPE_ORDER.map((k) => (
            <button
              key={k}
              onClick={() => {
                actions.setShapeKind(k);
                toolStore.setActive("shape");
                setOpen(false);
              }}
              title={SHAPE_LABEL[k]}
              className={`flex h-8 w-8 items-center justify-center rounded text-base transition-colors ${
                shape.kind === k
                  ? "bg-accent/20 text-ink ring-1 ring-accent/60"
                  : "text-muted hover:bg-panel hover:text-ink"
              }`}
            >
              {SHAPE_GLYPH[k]}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

export function ToolRail() {
  const { active } = useToolState();
  return (
    <div className="flex w-12 flex-col items-center border-r border-edge bg-panel py-2">
      <div className="flex flex-1 flex-col items-center gap-1">
        {TOOLS.map((t, i) => {
          const prev = TOOLS[i - 1];
          const dividerBefore = prev !== undefined && prev.group !== t.group;
          const selected = t.id === active;
          if (t.id === "shape") {
            return (
              <Fragment key={t.id}>
                {dividerBefore && <div className="my-1 h-px w-6 bg-edge" />}
                <ShapeButton selected={selected} />
              </Fragment>
            );
          }
          return (
            <Fragment key={t.id}>
              {dividerBefore && <div className="my-1 h-px w-6 bg-edge" />}
              <button
                onClick={() => selectTool(t.id)}
                className={`flex h-9 w-9 items-center justify-center rounded-md text-base transition-colors ${
                  selected
                    ? "bg-accent/20 text-ink ring-1 ring-accent/60"
                    : "text-muted hover:bg-panelraised hover:text-ink"
                }`}
                title={`${t.label} (${t.key})`}
              >
                {t.glyph}
              </button>
            </Fragment>
          );
        })}
      </div>
      {/* Foreground / background color + picker, always visible at the foot. */}
      <div className="mt-2 border-t border-edge pt-2">
        <ColorControls />
      </div>
    </div>
  );
}
