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
import type React from "react";
import { Fragment, useEffect, useRef, useState } from "react";
import {
  Move,
  SquareDashed,
  CircleDashed,
  Lasso,
  Wand2,
  MousePointerClick,
  Crop,
  Scaling,
  Paintbrush,
  Eraser,
  Stamp,
  Bandage,
  Sun,
  Moon,
  Droplet,
  Fingerprint,
  Triangle,
  PaintBucket,
  Blend,
  Grid3x3,
  PenTool,
  Type,
  Shapes,
  Pipette,
  Hand,
  Square,
  Circle,
  Slash,
  type LucideIcon,
} from "lucide-react";
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
  Icon: LucideIcon;
  label: string;
  /** Single-key shortcut (shown in the tooltip; bound in App). */
  key: string;
  /** Tools sharing a group are kept together; a divider falls between groups. */
  group: number;
}

export const TOOLS: ToolDef[] = [
  { id: "move", Icon: Move, label: "Move", key: "V", group: 0 },
  { id: "marquee-rect", Icon: SquareDashed, label: "Rectangle marquee", key: "M", group: 1 },
  { id: "marquee-ellipse", Icon: CircleDashed, label: "Ellipse marquee", key: "M", group: 1 },
  { id: "lasso", Icon: Lasso, label: "Lasso", key: "L", group: 1 },
  { id: "magic-wand", Icon: Wand2, label: "Magic wand", key: "W", group: 1 },
  // AI "Select Anything" (SAM, runs in-browser). Click an object to select it.
  { id: "sam-select", Icon: MousePointerClick, label: "Magic Select — click a subject (AI)", key: "A", group: 1 },
  { id: "crop", Icon: Crop, label: "Crop", key: "C", group: 2 },
  { id: "transform", Icon: Scaling, label: "Free transform", key: "T", group: 2 },
  { id: "brush", Icon: Paintbrush, label: "Brush", key: "B", group: 3 },
  { id: "eraser", Icon: Eraser, label: "Eraser", key: "E", group: 3 },
  { id: "clone", Icon: Stamp, label: "Clone stamp", key: "S", group: 3 },
  { id: "heal", Icon: Bandage, label: "Healing brush", key: "J", group: 3 },
  // Toning (dodge/burn) and focus (blur/sharpen/smudge) live in the rail as
  // grouped flyout buttons (handled specially below), mirroring the Shape tool.
  { id: "dodge", Icon: Sun, label: "Dodge / Burn", key: "O", group: 3 },
  { id: "blur-brush", Icon: Droplet, label: "Blur / Sharpen / Smudge", key: "", group: 3 },
  { id: "bucket", Icon: PaintBucket, label: "Paint bucket", key: "K", group: 4 },
  { id: "gradient", Icon: Blend, label: "Gradient", key: "G", group: 4 },
  { id: "pattern-stamp", Icon: Grid3x3, label: "Pattern stamp", key: "", group: 4 },
  { id: "pen", Icon: PenTool, label: "Pen (vector path)", key: "P", group: 5 },
  { id: "text", Icon: Type, label: "Type", key: "Y", group: 5 },
  // Shape lives in the rail too, but its icon + flyout are handled specially.
  { id: "shape", Icon: Shapes, label: "Shape", key: "U", group: 5 },
  { id: "eyedropper", Icon: Pipette, label: "Eyedropper", key: "I", group: 6 },
  { id: "hand", Icon: Hand, label: "Hand (pan)", key: "H", group: 6 },
];

/** Icons reused by both the rail buttons and the grouped flyouts. */
const TOOL_ICON: Partial<Record<ToolId, LucideIcon>> = {
  dodge: Sun,
  burn: Moon,
  smudge: Fingerprint,
  "blur-brush": Droplet,
  "sharpen-brush": Triangle,
};

/** Per-shape icons for the shape-tool button + its flyout. */
const SHAPE_ICON: Record<ShapeKind, LucideIcon> = {
  rect: Square,
  ellipse: Circle,
  line: Slash,
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
export function selectTool(id: ToolId): void {
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
  if (id === "sam-select") {
    // Selecting the AI "Magic Select" tool eagerly begins a SAM session so the
    // model starts downloading + the image gets encoded right away (the options
    // bar then shows the loading progress). The engine also begins lazily on the
    // first canvas click, so re-begin is a no-op when already active; we only
    // kick it off when there isn't already a live session.
    actions.setActiveTool("sam-select");
    if (!actions.isSamActive()) actions.samBeginOnActiveLayer();
    return;
  }
  toolStore.setActive(id);
}

/**
 * Close a flyout on outside-pointerdown / Escape. Shared by the shape button and
 * the grouped retouch flyouts so they all dismiss the same way.
 */
function useFlyoutDismiss(
  open: boolean,
  setOpen: (v: boolean) => void,
  rootRef: React.RefObject<HTMLDivElement | null>,
): void {
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
  }, [open, setOpen, rootRef]);
}

/**
 * A rail button that fronts a group of related tools (like the Shape button):
 * it shows the currently-active member's glyph and opens a flyout to pick a
 * sibling. Clicking the button selects whichever member is active (or the first,
 * if none is) so a single click still does something useful.
 */
function GroupButton({
  members,
  active,
  title,
  shortcut,
}: {
  members: { id: ToolId; Icon: LucideIcon; label: string }[];
  active: ToolId;
  title: string;
  /** Optional shortcut hint appended to the button tooltip. */
  shortcut?: string;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);
  useFlyoutDismiss(open, setOpen, rootRef);

  const current = members.find((m) => m.id === active) ?? members[0]!;
  const selected = members.some((m) => m.id === active);

  return (
    <div ref={rootRef} className="relative">
      <button
        onClick={() => {
          // Selecting the group adopts the current member (last-used wins).
          selectTool(current.id);
          setOpen((o) => !o);
        }}
        className={`relative flex h-9 w-9 items-center justify-center rounded-md transition-colors ${
          selected
            ? "bg-accent/20 text-ink ring-1 ring-accent/60"
            : "text-muted hover:bg-panelraised hover:text-ink"
        }`}
        title={`${title}${shortcut ? ` (${shortcut})` : ""} · click for more`}
      >
        <current.Icon size={18} strokeWidth={1.75} />
        <span className="absolute bottom-0.5 right-0.5 h-0 w-0 border-b-[4px] border-l-[4px] border-b-muted border-l-transparent" />
      </button>

      {open && (
        <div
          className="absolute left-full top-0 z-50 ml-1 flex gap-1 rounded-md border border-edge bg-panelraised p-1 shadow-lg"
          onPointerDown={(e) => e.stopPropagation()}
        >
          {members.map((m) => (
            <button
              key={m.id}
              onClick={() => {
                selectTool(m.id);
                setOpen(false);
              }}
              title={m.label}
              className={`flex h-8 w-8 items-center justify-center rounded transition-colors ${
                m.id === active
                  ? "bg-accent/20 text-ink ring-1 ring-accent/60"
                  : "text-muted hover:bg-panel hover:text-ink"
              }`}
            >
              <m.Icon size={17} strokeWidth={1.75} />
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/** The shape button: shows the active shapeKind glyph and a flyout to switch. */
function ShapeButton({ selected }: { selected: boolean }) {
  const { shape } = useToolState();
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);
  useFlyoutDismiss(open, setOpen, rootRef);
  const ShapeIcon = SHAPE_ICON[shape.kind];

  return (
    <div ref={rootRef} className="relative">
      <button
        onClick={() => {
          toolStore.setActive("shape");
          setOpen((o) => !o);
        }}
        className={`relative flex h-9 w-9 items-center justify-center rounded-md transition-colors ${
          selected
            ? "bg-accent/20 text-ink ring-1 ring-accent/60"
            : "text-muted hover:bg-panelraised hover:text-ink"
        }`}
        title={`Shape — ${SHAPE_LABEL[shape.kind]} (U) · click for more`}
      >
        <ShapeIcon size={18} strokeWidth={1.75} />
        {/* Flyout affordance: a little corner tick like Photoshop's tool groups. */}
        <span className="absolute bottom-0.5 right-0.5 h-0 w-0 border-b-[4px] border-l-[4px] border-b-muted border-l-transparent" />
      </button>

      {open && (
        <div
          className="absolute left-full top-0 z-50 ml-1 flex gap-1 rounded-md border border-edge bg-panelraised p-1 shadow-lg"
          onPointerDown={(e) => e.stopPropagation()}
        >
          {SHAPE_ORDER.map((k) => {
            const KIcon = SHAPE_ICON[k];
            return (
              <button
                key={k}
                onClick={() => {
                  actions.setShapeKind(k);
                  toolStore.setActive("shape");
                  setOpen(false);
                }}
                title={SHAPE_LABEL[k]}
                className={`flex h-8 w-8 items-center justify-center rounded transition-colors ${
                  shape.kind === k
                    ? "bg-accent/20 text-ink ring-1 ring-accent/60"
                    : "text-muted hover:bg-panel hover:text-ink"
                }`}
              >
                <KIcon size={17} strokeWidth={1.75} />
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

/** Tools fronted by the dodge/burn (toning) rail flyout. */
const TONING_GROUP: { id: ToolId; Icon: LucideIcon; label: string }[] = [
  { id: "dodge", Icon: TOOL_ICON.dodge!, label: "Dodge (lighten)" },
  { id: "burn", Icon: TOOL_ICON.burn!, label: "Burn (darken)" },
];
/** Tools fronted by the blur/sharpen/smudge (focus) rail flyout. */
const FOCUS_GROUP: { id: ToolId; Icon: LucideIcon; label: string }[] = [
  { id: "blur-brush", Icon: TOOL_ICON["blur-brush"]!, label: "Blur" },
  { id: "sharpen-brush", Icon: TOOL_ICON["sharpen-brush"]!, label: "Sharpen" },
  { id: "smudge", Icon: TOOL_ICON.smudge!, label: "Smudge" },
];

export function ToolRail() {
  const { active } = useToolState();
  return (
    <div className="flex w-12 flex-col items-center border-r border-edge bg-panel py-2">
      <div className="flex min-h-0 flex-1 flex-col items-center gap-1 overflow-y-auto">{/* scrolls if the rail is taller than the viewport */}
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
          // The "dodge" entry fronts the toning group (dodge + burn).
          if (t.id === "dodge") {
            return (
              <Fragment key={t.id}>
                {dividerBefore && <div className="my-1 h-px w-6 bg-edge" />}
                <GroupButton
                  members={TONING_GROUP}
                  active={active}
                  title="Dodge / Burn"
                  shortcut={t.key}
                />
              </Fragment>
            );
          }
          // The "blur-brush" entry fronts the focus group (blur/sharpen/smudge).
          if (t.id === "blur-brush") {
            return (
              <Fragment key={t.id}>
                {dividerBefore && <div className="my-1 h-px w-6 bg-edge" />}
                <GroupButton
                  members={FOCUS_GROUP}
                  active={active}
                  title="Blur / Sharpen / Smudge"
                />
              </Fragment>
            );
          }
          return (
            <Fragment key={t.id}>
              {dividerBefore && <div className="my-1 h-px w-6 bg-edge" />}
              <button
                onClick={() => selectTool(t.id)}
                className={`flex h-9 w-9 items-center justify-center rounded-md transition-colors ${
                  selected
                    ? "bg-accent/20 text-ink ring-1 ring-accent/60"
                    : "text-muted hover:bg-panelraised hover:text-ink"
                }`}
                title={t.key ? `${t.label} (${t.key})` : t.label}
              >
                <t.Icon size={18} strokeWidth={1.75} />
              </button>
            </Fragment>
          );
        })}
      </div>
      {/* Foreground / background color + picker, always visible at the foot. */}
      <div className="mt-2 shrink-0 border-t border-edge pt-2">
        <ColorControls />
      </div>
    </div>
  );
}
