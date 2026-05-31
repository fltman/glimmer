/**
 * Tool options bar — context-sensitive parameters for the active tool.
 * Brush/Eraser: size, opacity, hardness, flow. Marquee/Lasso: feather + a
 * "Deselect" action. Transform: numeric scale/rotation + Apply/Cancel. Crop:
 * aspect presets + Apply/Cancel. Text: font/size/style/align/color. Shape:
 * primitive + fill/stroke. Reads/writes only the tool store, the selection
 * actions, and the transform/crop/text/shape engine actions; never touches
 * pixels.
 */
import { useEffect, useRef, useState } from "react";
import {
  toolStore,
  useToolState,
  isPaintTool,
  isSelectionTool,
  isRetouchTool,
  usePatterns,
  usePatternState,
  renderPatternTile,
  type RGBAColor,
  type ShapeKind,
  type DodgeBurnRange,
  type GradientStopUI,
  type PatternDef,
} from "../state/tools";
import {
  actions,
  engine,
  useEngineSnapshot,
  useGradientParams,
  useSamState,
  useViewExtras,
  type TextWarp,
  type TextWarpStyle,
} from "../state/useEngine";
import type { TextLayerSnapshot } from "../model/Document";
import { ColorPicker } from "./color/ColorPicker";
import { rgbaCss } from "./color/colorMath";
import { BrushDynamicsButton, BrushPresetsButton } from "./brush";
import { PatternsButton } from "./patterns";

/** A tiny checkerboard-backed color chip (so alpha reads correctly). */
function ColorChip({ color, title }: { color: RGBAColor; title: string }) {
  const css = `rgba(${Math.round(color.r * 255)}, ${Math.round(
    color.g * 255,
  )}, ${Math.round(color.b * 255)}, ${color.a})`;
  return (
    <span
      title={title}
      className="inline-block h-4 w-4 rounded border border-edge"
      style={{
        backgroundColor: css,
        backgroundImage:
          "linear-gradient(45deg, #555 25%, transparent 25%, transparent 75%, #555 75%), linear-gradient(45deg, #555 25%, transparent 25%, transparent 75%, #555 75%)",
        backgroundSize: "6px 6px",
        backgroundPosition: "0 0, 3px 3px",
      }}
    >
      <span
        className="block h-full w-full rounded"
        style={{ backgroundColor: css }}
      />
    </span>
  );
}

/**
 * A color swatch button that opens the shared ColorPicker popover. Used by the
 * text + shape option bars to edit a per-tool color. `value` may be null, which
 * means "follow the foreground swatch"; the chip then renders the resolved
 * foreground and editing pins an explicit color.
 */
function SwatchButton({
  value,
  fallback,
  title,
  onChange,
  onClear,
}: {
  value: RGBAColor | null;
  /** Color shown (and used as the picker seed) when `value` is null. */
  fallback: RGBAColor;
  title: string;
  onChange: (c: RGBAColor) => void;
  /** When provided, a small "use foreground" reset is shown for non-null values. */
  onClear?: () => void;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const shown = value ?? fallback;

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
    <div ref={rootRef} className="relative inline-flex items-center gap-1">
      <button
        type="button"
        title={title}
        onClick={(e) => {
          e.stopPropagation();
          setOpen((o) => !o);
        }}
        className={`h-5 w-5 rounded border border-edge ${open ? "ring-1 ring-accent" : ""}`}
        style={{ backgroundColor: rgbaCss(shown) }}
      />
      {value !== null && onClear && (
        <button
          type="button"
          title="Use foreground color"
          onClick={onClear}
          className="text-[10px] leading-none text-muted hover:text-ink"
        >
          ⟲
        </button>
      )}
      {open && (
        <div
          className="absolute left-0 top-full z-50 mt-2"
          onPointerDown={(e) => e.stopPropagation()}
        >
          <ColorPicker value={shown} onChange={onChange} />
        </div>
      )}
    </div>
  );
}

function Slider({
  label,
  value,
  min,
  max,
  step,
  fmt,
  onChange,
  onCommit,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  fmt: (v: number) => string;
  onChange: (v: number) => void;
  /**
   * Optional "drag ended" callback (pointer-up / blur). When provided, `onChange`
   * is treated as a LIVE update (no undo step per tick) and `onCommit` records
   * the single undo step. Backward-compatible: omitting it keeps the old
   * one-undo-per-change behaviour for existing call sites.
   */
  onCommit?: (v: number) => void;
}) {
  return (
    <label className="flex items-center gap-2">
      <span className="w-14 text-[11px] text-muted">{label}</span>
      <input
        type="range"
        className="w-28"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        onPointerUp={
          onCommit ? (e) => onCommit(Number((e.target as HTMLInputElement).value)) : undefined
        }
        onKeyUp={
          onCommit ? (e) => onCommit(Number((e.target as HTMLInputElement).value)) : undefined
        }
      />
      <span className="w-10 text-right text-[11px] tabular-nums text-muted">
        {fmt(value)}
      </span>
    </label>
  );
}

/** Compact labelled numeric field (for the transform W/H/angle inputs). */
function NumField({
  label,
  value,
  step,
  suffix,
  width = "w-16",
  onCommit,
}: {
  label: string;
  value: number;
  step: number;
  suffix?: string;
  width?: string;
  onCommit: (v: number) => void;
}) {
  // Local text state so the field is editable while typing; commit on
  // blur/Enter and reflect external (pointer-driven) changes when not focused.
  const [text, setText] = useState(String(value));
  const [editing, setEditing] = useState(false);
  useEffect(() => {
    if (!editing) setText(String(value));
  }, [value, editing]);
  const commit = () => {
    const n = Number(text);
    if (Number.isFinite(n)) onCommit(n);
    setEditing(false);
  };
  return (
    <label className="flex items-center gap-1">
      <span className="text-[11px] text-muted">{label}</span>
      <input
        type="number"
        step={step}
        value={text}
        className={`${width} rounded border border-edge bg-panelraised px-1 py-0.5 text-[11px] tabular-nums text-ink`}
        onFocus={() => setEditing(true)}
        onChange={(e) => setText(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            (e.target as HTMLInputElement).blur();
          }
        }}
      />
      {suffix && <span className="text-[11px] text-muted">{suffix}</span>}
    </label>
  );
}

/** Small segmented toggle used for align + shapeKind. */
function Segmented<T extends string>({
  options,
  value,
  onChange,
}: {
  options: { id: T; label: string; title?: string }[];
  value: T;
  onChange: (v: T) => void;
}) {
  return (
    <div className="inline-flex overflow-hidden rounded border border-edge">
      {options.map((o) => (
        <button
          key={o.id}
          type="button"
          title={o.title ?? o.label}
          onClick={() => onChange(o.id)}
          className={`px-2 py-0.5 text-[11px] transition-colors ${
            value === o.id
              ? "bg-accent/20 text-ink"
              : "text-muted hover:bg-panelraised hover:text-ink"
          }`}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

/** Compact labelled checkbox matching the dark option-bar style. */
function Checkbox({
  label,
  checked,
  title,
  onChange,
}: {
  label: string;
  checked: boolean;
  title?: string;
  onChange: (v: boolean) => void;
}) {
  return (
    <label
      title={title}
      className="flex cursor-pointer items-center gap-1.5 text-[11px] text-muted"
    >
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        className="h-3 w-3 accent-accent"
      />
      <span>{label}</span>
    </label>
  );
}

/** Crop aspect presets (label → ratio, or null for free-form). */
const CROP_PRESETS: { id: string; label: string; ratio: number | null }[] = [
  { id: "free", label: "Free", ratio: null },
  { id: "1:1", label: "1:1", ratio: 1 },
  { id: "16:9", label: "16:9", ratio: 16 / 9 },
  { id: "4:3", label: "4:3", ratio: 4 / 3 },
];

/**
 * Transform option bar. Rotation is read live from the engine
 * (getTransformState().rotationDeg). Scale percentages are entered numerically
 * and pushed via setTransform({scaleX,scaleY}); pointer-driven scaling drives
 * the bake directly, so these inputs are an explicit-entry escape hatch seeded
 * to 100% at session begin. We watch the engine snapshot so rotation stays
 * fresh during pointer drags.
 */
function TransformBar() {
  // Subscribe to the snapshot: the engine emits on every transform mutation, so
  // this re-renders as the user drags the on-canvas handles.
  useEngineSnapshot();
  const st = engine.getTransformState();
  const rot = st ? Math.round(st.rotationDeg * 10) / 10 : 0;
  // Read the LIVE scale from the engine so the W/H% fields track on-canvas
  // handle drags (the engine exposes scaleX/scaleY in getTransformState).
  const wPct = st ? Math.round(st.scaleX * 1000) / 10 : 100;
  const hPct = st ? Math.round(st.scaleY * 1000) / 10 : 100;

  if (!st) {
    return (
      <span className="text-[11px] text-muted">
        No active transform — select a pixel layer, then re-pick the Transform
        tool to start.
      </span>
    );
  }

  return (
    <div className="flex items-center gap-3">
      <NumField
        label="W"
        value={wPct}
        step={1}
        suffix="%"
        onCommit={(v) => engine.setTransform({ scaleX: v / 100 })}
      />
      <NumField
        label="H"
        value={hPct}
        step={1}
        suffix="%"
        onCommit={(v) => engine.setTransform({ scaleY: v / 100 })}
      />
      <NumField
        label="Angle"
        value={rot}
        step={1}
        suffix="°"
        onCommit={(v) => engine.setTransform({ rotDeg: v })}
      />
      <span className="text-[11px] text-muted">
        Drag handles to scale · corner-out to rotate · Shift constrains
      </span>
      <div className="ml-auto flex items-center gap-2">
        <button className="btn-accent" onClick={() => actions.commitTransform()}>
          Apply
        </button>
        <button className="btn" onClick={() => actions.cancelTransform()}>
          Cancel
        </button>
      </div>
    </div>
  );
}

/** Crop option bar: aspect presets + Apply/Cancel. */
function CropBar() {
  useEngineSnapshot();
  const active = engine.isCropping();
  const [preset, setPreset] = useState("free");

  if (!active) {
    return (
      <span className="text-[11px] text-muted">
        No active crop — re-pick the Crop tool to start, then drag a region.
      </span>
    );
  }

  return (
    <div className="flex items-center gap-3">
      <span className="text-[11px] text-muted">Aspect</span>
      <div className="inline-flex overflow-hidden rounded border border-edge">
        {CROP_PRESETS.map((p) => (
          <button
            key={p.id}
            type="button"
            onClick={() => setPreset(p.id)}
            className={`px-2 py-0.5 text-[11px] transition-colors ${
              preset === p.id
                ? "bg-accent/20 text-ink"
                : "text-muted hover:bg-panelraised hover:text-ink"
            }`}
          >
            {p.label}
          </button>
        ))}
      </div>
      <span className="text-[11px] text-muted">
        Drag edges/corners to size · Enter applies · Esc cancels
      </span>
      <div className="ml-auto flex items-center gap-2">
        <button className="btn-accent" onClick={() => actions.commitCrop()}>
          Apply
        </button>
        <button className="btn" onClick={() => actions.cancelCrop()}>
          Cancel
        </button>
      </div>
    </div>
  );
}

const FONT_FAMILIES: { value: string; label: string }[] = [
  { value: "Inter, system-ui, sans-serif", label: "Inter" },
  { value: "system-ui, sans-serif", label: "System UI" },
  { value: "Georgia, 'Times New Roman', serif", label: "Georgia" },
  { value: "'Times New Roman', Times, serif", label: "Times" },
  { value: "'Courier New', monospace", label: "Courier" },
  { value: "'Helvetica Neue', Arial, sans-serif", label: "Helvetica" },
  { value: "Arial, sans-serif", label: "Arial" },
];

/** Warp envelope styles for the Type warp dropdown (label + id). */
const TEXT_WARP_STYLES: { id: TextWarpStyle; label: string }[] = [
  { id: "none", label: "None" },
  { id: "arc", label: "Arc" },
  { id: "arch", label: "Arch" },
  { id: "bulge", label: "Bulge" },
  { id: "wave", label: "Wave" },
  { id: "flag", label: "Flag" },
  { id: "rise", label: "Rise" },
];

/**
 * Per-layer Type controls that operate on the ACTIVE text layer (read from the
 * snapshot): "On path" (type-on-a-path binding) + "Warp" (Photoshop-style
 * envelope). These only appear when the active layer is a text layer; the
 * font/size/style/align/color defaults above always apply to NEW type. We
 * subscribe to the engine snapshot so the readouts track path construction,
 * layer switches, and undo/redo.
 *
 *   · On path: a dropdown of committed paths (engine.getPaths()) + a "none"
 *     entry. Selecting a path calls actions.setTextPath(layerId, pathId|null).
 *     Disabled when no paths exist (hint: draw one with the Pen tool first).
 *   · Warp: a style dropdown + a Bend slider (-100..100 → -1..1) and optional
 *     H/V distortion sliders, calling actions.setTextWarp(layerId, {...}).
 *     Picking "None" clears the warp (flat text restored).
 */
function TextPathWarpControls() {
  const snap = useEngineSnapshot();
  // Snapshot of the text params captured at the start of a live slider drag, so
  // a continuous drag commits exactly ONE undo step (prev = drag-start, next =
  // release) instead of one step per range-input tick.
  const dragStart = useRef<TextLayerSnapshot | null>(null);
  // The active text layer (if any). Path/warp bind to a concrete layer, so we
  // only render these controls when the active layer actually is text.
  const active = snap.layers.find((l) => l.id === snap.activeLayerId);
  const textLayer =
    active && active.kind === "text" && active.text ? active : null;
  if (!textLayer || !textLayer.text) return null;

  const layerId = textLayer.id;
  const ts = textLayer.text;
  const paths = engine.getPaths();
  const hasPaths = paths.length > 0;
  // The bound path id, normalized to "" (none) for the <select> value. If the
  // bound path was since deleted it won't be in the list, so fall back to none.
  const boundId =
    ts.pathId && paths.some((p) => p.id === ts.pathId) ? ts.pathId : "";

  const warp: TextWarp = ts.warp ?? { style: "none", bend: 0 };
  const warped = warp.style !== "none";

  // Style changes are discrete → one undo step via the engine's setTextWarp.
  const setWarpStyle = (style: TextWarpStyle) => {
    if (style === "none") actions.setTextWarp(layerId, null);
    else actions.setTextWarp(layerId, { ...warp, style });
  };

  // LIVE warp slider update (no undo step) — re-rasterizes via updateTextLayer.
  const liveWarp = (patch: Partial<TextWarp>) => {
    if (!dragStart.current) {
      // Capture the pre-drag params so the eventual commit has a correct "prev".
      dragStart.current = { ...ts, color: { ...ts.color }, warp: ts.warp ? { ...ts.warp } : undefined };
    }
    const next: TextWarp = { ...warp, ...patch };
    actions.updateTextLayer(layerId, {
      warp: next.style === "none" ? null : next,
    });
  };
  // Commit the drag as a single undo step (prev = drag-start, next = live state).
  const commitWarp = (patch: Partial<TextWarp>) => {
    const prev = dragStart.current;
    dragStart.current = null;
    const next: TextWarp = { ...warp, ...patch };
    const nextWarp = next.style === "none" ? undefined : next;
    if (!prev) {
      // No live drag was tracked (e.g. keyboard nudge): fall back to a direct
      // undoable set so the change is still recorded.
      actions.setTextWarp(layerId, nextWarp ?? null);
      return;
    }
    actions.commitTextLayer(layerId, prev, { ...prev, warp: nextWarp });
  };

  return (
    <div className="flex items-center gap-3 border-l border-edge pl-3">
      {/* ── Type on a path ── */}
      <label
        className="flex items-center gap-1"
        title={
          hasPaths
            ? "Lay the glyphs along a committed vector path"
            : "Draw a path with the Pen tool first"
        }
      >
        <span className="text-[11px] text-muted">On path</span>
        <select
          value={boundId}
          disabled={!hasPaths}
          onChange={(e) =>
            actions.setTextPath(layerId, e.target.value || null)
          }
          className="rounded border border-edge bg-panelraised px-1 py-0.5 text-[11px] text-ink disabled:opacity-40"
        >
          <option value="">{hasPaths ? "None" : "No paths"}</option>
          {paths.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
      </label>

      {/* ── Warp envelope ── */}
      <label className="flex items-center gap-1" title="Photoshop-style text warp">
        <span className="text-[11px] text-muted">Warp</span>
        <select
          value={warp.style}
          onChange={(e) => setWarpStyle(e.target.value as TextWarpStyle)}
          className="rounded border border-edge bg-panelraised px-1 py-0.5 text-[11px] text-ink"
        >
          {TEXT_WARP_STYLES.map((w) => (
            <option key={w.id} value={w.id}>
              {w.label}
            </option>
          ))}
        </select>
      </label>

      {/* Bend + H/V distortion only matter once a warp style is chosen. */}
      {warped && (
        <>
          <Slider
            label="Bend"
            value={Math.round((warp.bend ?? 0) * 100)}
            min={-100}
            max={100}
            step={1}
            fmt={(v) => `${Math.round(v)}%`}
            onChange={(v) => liveWarp({ bend: v / 100 })}
            onCommit={(v) => commitWarp({ bend: v / 100 })}
          />
          <Slider
            label="H"
            value={Math.round((warp.horizontal ?? 0) * 100)}
            min={-100}
            max={100}
            step={1}
            fmt={(v) => `${Math.round(v)}%`}
            onChange={(v) => liveWarp({ horizontal: v / 100 })}
            onCommit={(v) => commitWarp({ horizontal: v / 100 })}
          />
          <Slider
            label="V"
            value={Math.round((warp.vertical ?? 0) * 100)}
            min={-100}
            max={100}
            step={1}
            fmt={(v) => `${Math.round(v)}%`}
            onChange={(v) => liveWarp({ vertical: v / 100 })}
            onCommit={(v) => commitWarp({ vertical: v / 100 })}
          />
        </>
      )}
    </div>
  );
}

/**
 * Type-tool option bar. Edits the tool-store defaults for NEW text layers (and,
 * when a text layer is being edited, the engine separately mirrors these into
 * the live layer via updateTextLayer — wired in CanvasHost's textarea overlay).
 * `color` is the explicit per-tool color, or null to follow the foreground.
 * When the active layer is a text layer, per-layer Type-on-path + Warp controls
 * are appended (see TextPathWarpControls).
 */
function TextBar() {
  const { text, foreground } = useToolState();
  return (
    <div className="flex items-center gap-3">
      <select
        value={text.fontFamily}
        onChange={(e) => actions.setTextParams({ fontFamily: e.target.value })}
        className="rounded border border-edge bg-panelraised px-1 py-0.5 text-[11px] text-ink"
        title="Font family"
      >
        {FONT_FAMILIES.map((f) => (
          <option key={f.value} value={f.value}>
            {f.label}
          </option>
        ))}
      </select>

      <NumField
        label="Size"
        value={text.fontSize}
        step={1}
        suffix="px"
        onCommit={(v) =>
          actions.setTextParams({ fontSize: Math.max(1, Math.round(v)) })
        }
      />

      <div className="inline-flex overflow-hidden rounded border border-edge">
        <button
          type="button"
          title="Bold"
          onClick={() => actions.setTextParams({ bold: !text.bold })}
          className={`px-2 py-0.5 text-[11px] font-bold transition-colors ${
            text.bold ? "bg-accent/20 text-ink" : "text-muted hover:bg-panelraised hover:text-ink"
          }`}
        >
          B
        </button>
        <button
          type="button"
          title="Italic"
          onClick={() => actions.setTextParams({ italic: !text.italic })}
          className={`px-2 py-0.5 text-[11px] italic transition-colors ${
            text.italic ? "bg-accent/20 text-ink" : "text-muted hover:bg-panelraised hover:text-ink"
          }`}
        >
          I
        </button>
      </div>

      <Segmented<"left" | "center" | "right">
        options={[
          { id: "left", label: "⯇", title: "Align left" },
          { id: "center", label: "≡", title: "Align center" },
          { id: "right", label: "⯈", title: "Align right" },
        ]}
        value={text.align}
        onChange={(align) => actions.setTextParams({ align })}
      />

      <div className="flex items-center gap-1">
        <span className="text-[11px] text-muted">Color</span>
        <SwatchButton
          value={text.color}
          fallback={foreground}
          title="Text color (defaults to foreground)"
          onChange={(c) => actions.setTextParams({ color: c })}
          onClear={() => actions.setTextParams({ color: null })}
        />
      </div>

      <span className="text-[11px] text-muted">Click the canvas to add type</span>

      {/* Per-layer Type-on-path + Warp (shown only for the active text layer). */}
      <TextPathWarpControls />
    </div>
  );
}

/** Per-shape glyphs for the segmented kind toggle. */
const SHAPE_SEG: { id: ShapeKind; label: string; title: string }[] = [
  { id: "rect", label: "▱", title: "Rectangle" },
  { id: "ellipse", label: "◯", title: "Ellipse" },
  { id: "line", label: "╱", title: "Line" },
];

/** Shape-tool option bar: primitive + fill/stroke. */
function ShapeBar() {
  const { shape, foreground } = useToolState();
  return (
    <div className="flex items-center gap-3">
      <Segmented<ShapeKind>
        options={SHAPE_SEG}
        value={shape.kind}
        onChange={(kind) => actions.setShapeKind(kind)}
      />

      {/* Line has no fill; only rect/ellipse expose the fill swatch. */}
      {shape.kind !== "line" && (
        <div className="flex items-center gap-1">
          <span className="text-[11px] text-muted">Fill</span>
          <SwatchButton
            value={shape.fill}
            fallback={foreground}
            title="Fill color (defaults to foreground)"
            onChange={(c) => actions.setShapeParams({ fill: c })}
            onClear={() => actions.setShapeParams({ fill: null })}
          />
        </div>
      )}

      <div className="flex items-center gap-1">
        <span className="text-[11px] text-muted">Stroke</span>
        <SwatchButton
          value={shape.stroke.color}
          fallback={shape.stroke.color}
          title="Stroke color"
          onChange={(c) =>
            actions.setShapeParams({
              stroke: { ...shape.stroke, color: c },
            })
          }
        />
        <NumField
          label=""
          value={shape.stroke.width}
          step={1}
          suffix="px"
          width="w-12"
          onCommit={(v) =>
            actions.setShapeParams({
              stroke: { ...shape.stroke, width: Math.max(0, Math.round(v)) },
            })
          }
        />
      </div>

      <span className="text-[11px] text-muted">
        Drag to draw · Shift constrains{" "}
        {shape.kind === "line" ? "to 45°" : shape.kind === "ellipse" ? "to a circle" : "to a square"}
      </span>
    </div>
  );
}

/**
 * Magic-wand option bar: tolerance + contiguous/all-layers toggles, plus quick
 * selection actions. Clicking the canvas with the wand active auto-triggers the
 * engine's magicWandSelect with these params (Shift add · Alt subtract).
 */
function MagicWandBar() {
  const { magicWand, feather } = useToolState();
  return (
    <div className="flex items-center gap-4">
      <Slider
        label="Tolerance"
        value={magicWand.tolerance}
        min={0}
        max={255}
        step={1}
        fmt={(v) => `${Math.round(v)}`}
        onChange={(v) => actions.setMagicWandParams({ tolerance: Math.round(v) })}
      />
      <Checkbox
        label="Contiguous"
        checked={magicWand.contiguous}
        title="Flood-fill from the clicked pixel (off = match the color everywhere)"
        onChange={(contiguous) => actions.setMagicWandParams({ contiguous })}
      />
      <Checkbox
        label="Sample all layers"
        checked={magicWand.sampleAllLayers}
        title="Sample the flattened composite instead of just the active layer"
        onChange={(sampleAllLayers) =>
          actions.setMagicWandParams({ sampleAllLayers })
        }
      />
      <Slider
        label="Feather"
        value={feather}
        min={0}
        max={32}
        step={1}
        fmt={(v) => `${Math.round(v)}px`}
        onChange={(v) => toolStore.setFeather(v)}
      />
      <span className="text-[11px] text-muted">Click to select · Shift add · Alt subtract</span>
      <div className="ml-auto flex items-center gap-2">
        <button className="btn" onClick={() => actions.selectAll()}>
          Select all
        </button>
        <button className="btn" onClick={() => actions.invertSelection()}>
          Inverse
        </button>
        <button className="btn" onClick={() => actions.clearSelection()}>
          Deselect
        </button>
      </div>
    </div>
  );
}

/**
 * A tiny inline spinner matching the client-ML progress style — a thin accent
 * ring that rotates. Used in the SAM option bar while the model loads / runs.
 */
function Spinner() {
  return (
    <span
      aria-hidden
      className="inline-block h-3 w-3 animate-spin rounded-full border-2 border-edge border-t-accent"
    />
  );
}

/**
 * SAM "Magic Select" (Select Anything) option bar. The heavy lifting runs in a
 * Web Worker (SlimSAM via transformers.js, WebGPU → WASM); this bar is purely a
 * reactive readout + commit/cancel controls. It reads useSamState() (active /
 * imageReady / busy / points / candidate / status / error) and drives the engine
 * SAM session — it never touches pixels.
 *
 * Flow: picking the tool begins the session (model loads + image is encoded
 * once). Clicking the canvas adds a positive point; Alt-click subtracts. The
 * engine renders a live tinted candidate overlay in GL, so this bar only needs
 * to report status and offer Apply (fold the candidate into the selection),
 * Clear points (restart the prompt without re-encoding) and Cancel.
 */
function SamSelectBar() {
  const sam = useSamState();

  // Status line, in priority order: error → model/encode loading → segmenting →
  // ready-with-candidate → ready-waiting-for-a-click → cold (not begun yet).
  let status: string;
  if (sam.error) {
    status = `Couldn't load the model — ${sam.error}`;
  } else if (sam.status) {
    // "Loading model…" / "Analyzing image…" / "Segmenting…" from the worker.
    status = sam.status;
  } else if (!sam.active || !sam.imageReady) {
    status = "Preparing — pick a layer, then click the subject";
  } else if (sam.hasCandidate) {
    status = `Selection ready (${Math.round(sam.score * 100)}% match) · Enter to apply`;
  } else {
    status = "Click an object · Alt-click to subtract a region";
  }

  const loading = !sam.error && (!!sam.status || (sam.active && !sam.imageReady));
  const hasPoints = sam.points.length > 0;

  return (
    <div className="flex items-center gap-3">
      {/* Status + spinner while the model loads or the worker is running. */}
      <span className="flex items-center gap-2 text-[11px]">
        {(loading || sam.busy) && <Spinner />}
        <span className={sam.error ? "text-amber-400" : "text-muted"}>
          {status}
        </span>
      </span>

      <span className="text-[11px] text-muted">
        Click add · Alt-click subtract
      </span>

      <div className="ml-auto flex items-center gap-2">
        <button
          className="btn-accent"
          // Apply needs a candidate; replace the selection with it.
          disabled={!sam.hasCandidate}
          title="Turn the highlighted region into the active selection"
          onClick={() => actions.samCommit("replace")}
        >
          Apply
        </button>
        <button
          className="btn"
          // Drop the clicked points + candidate WITHOUT re-encoding (the worker
          // keeps the image embeddings warm), so this is instant.
          disabled={!hasPoints}
          title="Discard the clicked points and start over"
          onClick={() => actions.samClearPoints()}
        >
          Clear points
        </button>
        <button
          className="btn"
          title="Cancel — leave the current selection unchanged"
          onClick={() => actions.samCancel()}
        >
          Cancel
        </button>
      </div>
    </div>
  );
}

/**
 * Clone-stamp / healing-brush option bar (shared `clone` params). Shows the live
 * clone source set via Alt-click (the engine emits a snapshot when it changes,
 * so this readout stays fresh).
 */
function CloneBar({ heal }: { heal: boolean }) {
  const { clone } = useToolState();
  // Subscribe to the engine snapshot so the source readout updates on Alt-click.
  useEngineSnapshot();
  const src = engine.getCloneSource();
  return (
    <div className="flex items-center gap-4">
      <Slider
        label="Size"
        value={clone.size}
        min={1}
        max={512}
        step={1}
        fmt={(v) => `${Math.round(v)}px`}
        onChange={(v) => actions.setCloneParams({ size: v })}
      />
      <Slider
        label="Hardness"
        value={clone.hardness}
        min={0}
        max={1}
        step={0.01}
        fmt={(v) => `${Math.round(v * 100)}%`}
        onChange={(v) => actions.setCloneParams({ hardness: v })}
      />
      <Slider
        label="Opacity"
        value={clone.opacity}
        min={0}
        max={1}
        step={0.01}
        fmt={(v) => `${Math.round(v * 100)}%`}
        onChange={(v) => actions.setCloneParams({ opacity: v })}
      />
      <Checkbox
        label="Aligned"
        checked={clone.aligned}
        title="Keep the source offset fixed across strokes (off = re-anchor each stroke)"
        onChange={(aligned) => actions.setCloneParams({ aligned })}
      />
      <span className="text-[11px] text-muted">
        Alt-click to set the {heal ? "healing" : "clone"} source
        {src
          ? ` · source ${Math.round(src.x)}, ${Math.round(src.y)}`
          : " · no source set"}
      </span>
    </div>
  );
}

/** Tonal-range options for dodge/burn. */
const DB_RANGE: { id: DodgeBurnRange; label: string; title: string }[] = [
  { id: "shadows", label: "Shadows", title: "Affect dark tones" },
  { id: "midtones", label: "Mids", title: "Affect mid tones" },
  { id: "highlights", label: "Highlights", title: "Affect bright tones" },
];

/** Dodge / burn option bar (shared `dodgeBurn` params). */
function DodgeBurnBar({ burn }: { burn: boolean }) {
  const { dodgeBurn } = useToolState();
  return (
    <div className="flex items-center gap-4">
      <Slider
        label="Size"
        value={dodgeBurn.size}
        min={1}
        max={512}
        step={1}
        fmt={(v) => `${Math.round(v)}px`}
        onChange={(v) => actions.setDodgeBurnParams({ size: v })}
      />
      <Slider
        label="Hardness"
        value={dodgeBurn.hardness}
        min={0}
        max={1}
        step={0.01}
        fmt={(v) => `${Math.round(v * 100)}%`}
        onChange={(v) => actions.setDodgeBurnParams({ hardness: v })}
      />
      <Slider
        label="Exposure"
        value={dodgeBurn.exposure}
        min={0}
        max={1}
        step={0.01}
        fmt={(v) => `${Math.round(v * 100)}%`}
        onChange={(v) => actions.setDodgeBurnParams({ exposure: v })}
      />
      <div className="flex items-center gap-2">
        <span className="text-[11px] text-muted">Range</span>
        <Segmented<DodgeBurnRange>
          options={DB_RANGE}
          value={dodgeBurn.range}
          onChange={(range) => actions.setDodgeBurnParams({ range })}
        />
      </div>
      <span className="text-[11px] text-muted">
        Drag to {burn ? "darken" : "lighten"} the {dodgeBurn.range}
      </span>
    </div>
  );
}

/** Smudge option bar. */
function SmudgeBar() {
  const { smudge } = useToolState();
  return (
    <div className="flex items-center gap-4">
      <Slider
        label="Size"
        value={smudge.size}
        min={1}
        max={512}
        step={1}
        fmt={(v) => `${Math.round(v)}px`}
        onChange={(v) => actions.setSmudgeParams({ size: v })}
      />
      <Slider
        label="Hardness"
        value={smudge.hardness}
        min={0}
        max={1}
        step={0.01}
        fmt={(v) => `${Math.round(v * 100)}%`}
        onChange={(v) => actions.setSmudgeParams({ hardness: v })}
      />
      <Slider
        label="Strength"
        value={smudge.strength}
        min={0}
        max={1}
        step={0.01}
        fmt={(v) => `${Math.round(v * 100)}%`}
        onChange={(v) => actions.setSmudgeParams({ strength: v })}
      />
      <span className="text-[11px] text-muted">Drag to smear color along the path</span>
    </div>
  );
}

/** Blur / sharpen brush option bar (shared `focus` params). */
function FocusBar({ sharpen }: { sharpen: boolean }) {
  const { focus } = useToolState();
  return (
    <div className="flex items-center gap-4">
      <Slider
        label="Size"
        value={focus.size}
        min={1}
        max={512}
        step={1}
        fmt={(v) => `${Math.round(v)}px`}
        onChange={(v) => actions.setFocusParams({ size: v })}
      />
      <Slider
        label="Hardness"
        value={focus.hardness}
        min={0}
        max={1}
        step={0.01}
        fmt={(v) => `${Math.round(v * 100)}%`}
        onChange={(v) => actions.setFocusParams({ hardness: v })}
      />
      <Slider
        label="Strength"
        value={focus.strength}
        min={0}
        max={1}
        step={0.01}
        fmt={(v) => `${Math.round(v * 100)}%`}
        onChange={(v) => actions.setFocusParams({ strength: v })}
      />
      <span className="text-[11px] text-muted">
        Drag to {sharpen ? "sharpen" : "blur"} under the brush
      </span>
    </div>
  );
}

/**
 * A small canvas chip previewing a pattern tile (the SAME tile the engine
 * uploads, via renderPatternTile) tiled across the chip. Used in the pattern-
 * stamp option bar and the bucket "Fill with Pattern" affordance so the active
 * pattern is visible at a glance.
 */
function PatternChip({ def, size = 20 }: { def: PatternDef; size?: number }) {
  const ref = useRef<HTMLCanvasElement | null>(null);
  useEffect(() => {
    const cv = ref.current;
    if (!cv) return;
    const ctx = cv.getContext("2d");
    if (!ctx) return;
    const img = renderPatternTile(def);
    if (!img) return;
    const tile = document.createElement("canvas");
    tile.width = img.width;
    tile.height = img.height;
    tile.getContext("2d")?.putImageData(img, 0, 0);
    ctx.clearRect(0, 0, cv.width, cv.height);
    ctx.imageSmoothingEnabled = false;
    const pat = ctx.createPattern(tile, "repeat");
    if (pat) {
      ctx.fillStyle = pat;
      ctx.fillRect(0, 0, cv.width, cv.height);
    } else {
      for (let y = 0; y < cv.height; y += img.height)
        for (let x = 0; x < cv.width; x += img.width) ctx.drawImage(tile, x, y);
    }
  }, [def]);
  return (
    <canvas
      ref={ref}
      width={size}
      height={size}
      title={`Active pattern: ${def.name}`}
      className="rounded border border-edge"
      style={{ imageRendering: "pixelated", width: size, height: size }}
    />
  );
}

/**
 * Pattern-stamp option bar: active-pattern chip + Patterns picker popover, plus
 * scale + opacity sliders (shared with fill via the patternStore). Painting is
 * handled by the engine's own pattern-stamp gesture; these just set the wet-dab
 * params it reads. Reads usePatterns()/usePatternState() and writes through
 * actions.setPattern / setPatternScale / setPatternOpacity.
 */
function PatternStampBar() {
  const patterns = usePatterns();
  const { selectedId, scale, opacity } = usePatternState();
  const def =
    patterns.find((p) => p.id === selectedId) ?? patterns[0];
  return (
    <div className="flex items-center gap-3">
      <div className="flex items-center gap-1.5">
        <span className="text-[11px] text-muted">Pattern</span>
        {def && <PatternChip def={def} />}
        <PatternsButton label="Choose" />
      </div>
      <Slider
        label="Scale"
        value={scale}
        min={0.05}
        max={8}
        step={0.05}
        fmt={(v) => `${Math.round(v * 100)}%`}
        onChange={(v) => actions.setPatternScale(v)}
      />
      <Slider
        label="Opacity"
        value={opacity}
        min={0}
        max={1}
        step={0.01}
        fmt={(v) => `${Math.round(v * 100)}%`}
        onChange={(v) => actions.setPatternOpacity(v)}
      />
      <span className="text-[11px] text-muted">
        Drag to stamp the pattern · constrained to the selection when set
      </span>
    </div>
  );
}

/** True if a path description has at least one closed subpath (>= 2 anchors). */
function pathHasClosedRegion(
  p: ReturnType<typeof engine.getActivePath>,
): boolean {
  return (
    !!p && p.subpaths.some((sp) => sp.closed && sp.anchors.length >= 2)
  );
}

/**
 * Pen-tool option bar: turn the active/live vector path into a selection, fill
 * it, or stroke it on the active raster layer (using the foreground color + the
 * brush width for the stroke), plus delete the path. Fill / Make-Selection need
 * a closed region; Stroke + Delete only need a path to exist. We subscribe to
 * the engine snapshot so enablement tracks live path construction.
 */
function PenBar() {
  useEngineSnapshot();
  const { foreground, brush } = useToolState();
  const active = engine.getActivePath();
  const drawing = engine.isDrawingPath();
  const hasPath = active !== null;
  const hasClosed = pathHasClosedRegion(active);

  return (
    <div className="flex items-center gap-3">
      <button
        className="btn"
        disabled={!hasClosed}
        title="Convert the closed path into the active selection"
        onClick={() => actions.makePathSelection(undefined, "replace", "nonzero")}
      >
        Make Selection
      </button>
      <button
        className="btn"
        disabled={!hasClosed}
        title="Fill the closed region with the foreground color"
        onClick={() => actions.fillPath(undefined, foreground, "nonzero")}
      >
        Fill Path
      </button>
      <button
        className="btn"
        disabled={!hasPath}
        title="Stroke the path outline with the foreground color at the brush width"
        onClick={() =>
          actions.strokePath(undefined, {
            width: Math.max(1, Math.round(brush.size)),
            color: foreground,
          })
        }
      >
        Stroke Path
      </button>
      <button
        className="btn"
        disabled={!hasPath}
        title="Delete the active path"
        onClick={() => {
          // Discard an in-progress live path; otherwise drop the committed one.
          if (drawing) actions.clearActivePath();
          else actions.deletePath();
        }}
      >
        Delete Path
      </button>
      <span className="text-[11px] text-muted">
        {drawing
          ? "Click to add anchors · drag for curves · click the first anchor to close · Enter commits · Esc discards"
          : hasPath
            ? "Click the canvas to start a new path"
            : "Click the canvas to place the first anchor"}
      </span>
    </div>
  );
}

/**
 * Compact gradient editor: a horizontal preview bar with draggable stops.
 *   · click empty bar  → add a stop at that position (color sampled from the ramp)
 *   · drag a stop      → move it (position 0..1)
 *   · click a stop     → open the shared ColorPicker to recolor it
 *   · double-click / Del on a selected stop → remove it (min two stops kept)
 * Edits go through actions.setGradientStops (which clamps + sorts + floors at 2).
 */
function GradientEditor({
  stops,
  reverse,
}: {
  stops: GradientStopUI[];
  reverse: boolean;
}) {
  const barRef = useRef<HTMLDivElement | null>(null);
  const [selected, setSelected] = useState(0);
  const [pickerOpen, setPickerOpen] = useState(false);
  const dragRef = useRef<{ index: number; moved: boolean } | null>(null);

  // Keep the selected index in range as stops are added/removed.
  const sel = Math.min(selected, stops.length - 1);
  const selStop = stops[sel]!;

  // The CSS preview gradient (respecting the reverse toggle, like the engine).
  // Sort the color-stop list by the displayed position so CSS sees ascending
  // offsets regardless of the (already-sorted-by-pos) store order under reverse.
  const previewCss = `linear-gradient(to right, ${stops
    .map((s) => ({
      at: (reverse ? 1 - s.pos : s.pos) * 100,
      css: rgbaCss(s.color),
    }))
    .sort((a, b) => a.at - b.at)
    .map((s) => `${s.css} ${s.at}%`)
    .join(", ")})`;

  /**
   * Map a clientX to a STORED 0..1 stop position. The bar is drawn (and handles
   * placed) in DISPLAY space, which is flipped when `reverse` is on, so the raw
   * left-to-right bar fraction must be inverted back into stored-pos space —
   * otherwise dragging/adding a stop under reverse lands on the opposite side.
   */
  const posFromClientX = (clientX: number): number => {
    const el = barRef.current;
    if (!el) return 0;
    const r = el.getBoundingClientRect();
    const t = (clientX - r.left) / r.width;
    const barPos = t < 0 ? 0 : t > 1 ? 1 : t;
    return reverse ? 1 - barPos : barPos;
  };

  // Sample the ramp color at a position (linear interp between bounding stops).
  const sampleRamp = (pos: number): RGBAColor => {
    const ordered = [...stops].sort((a, b) => a.pos - b.pos);
    if (pos <= ordered[0]!.pos) return { ...ordered[0]!.color };
    const last = ordered[ordered.length - 1]!;
    if (pos >= last.pos) return { ...last.color };
    for (let i = 0; i < ordered.length - 1; i++) {
      const lo = ordered[i]!;
      const hi = ordered[i + 1]!;
      if (pos >= lo.pos && pos <= hi.pos) {
        const t = hi.pos === lo.pos ? 0 : (pos - lo.pos) / (hi.pos - lo.pos);
        const mix = (a: number, b: number) => a + (b - a) * t;
        return {
          r: mix(lo.color.r, hi.color.r),
          g: mix(lo.color.g, hi.color.g),
          b: mix(lo.color.b, hi.color.b),
          a: mix(lo.color.a, hi.color.a),
        };
      }
    }
    return { ...last.color };
  };

  // Add a stop at the clicked position (selecting it). Identity match by the
  // (pos,color) we just inserted so we can re-select after the store re-sorts.
  const addStopAt = (pos: number) => {
    const color = sampleRamp(pos);
    const next = [...stops, { pos, color }];
    actions.setGradientStops(next);
    // After normalize the new stop is sorted in; find it by position.
    const sorted = [...next].sort((a, b) => a.pos - b.pos);
    setSelected(sorted.findIndex((s) => s === next[next.length - 1]));
    setPickerOpen(false);
  };

  const moveStop = (index: number, pos: number) => {
    const next = stops.map((s, i) => (i === index ? { ...s, pos } : s));
    actions.setGradientStops(next);
    // Re-find the dragged stop after the store sorts so the handle keeps focus.
    const sorted = [...next].sort((a, b) => a.pos - b.pos);
    setSelected(sorted.indexOf(next[index]!));
  };

  const removeStop = (index: number) => {
    if (stops.length <= 2) return; // store floors at two anyway
    const next = stops.filter((_, i) => i !== index);
    actions.setGradientStops(next);
    setSelected((s) => Math.max(0, Math.min(s, next.length - 1)));
    setPickerOpen(false);
  };

  const recolor = (index: number, color: RGBAColor) => {
    actions.setGradientStops(stops.map((s, i) => (i === index ? { ...s, color } : s)));
  };

  // Window-level drag handling while a stop is being moved.
  useEffect(() => {
    function onMove(e: PointerEvent) {
      const d = dragRef.current;
      if (!d) return;
      d.moved = true;
      moveStop(d.index, posFromClientX(e.clientX));
    }
    function onUp() {
      dragRef.current = null;
    }
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
    // moveStop closes over `stops`; re-bind when they change.
  }, [stops]);

  // Del key removes the selected stop while the editor area is focused.
  return (
    <div className="flex items-center gap-2">
      <div
        className="relative"
        tabIndex={0}
        onKeyDown={(e) => {
          if (e.key === "Delete" || e.key === "Backspace") {
            e.preventDefault();
            removeStop(sel);
          }
        }}
      >
        {/* The ramp preview + click-to-add surface. */}
        <div
          ref={barRef}
          title="Click to add a stop · drag stops to move · double-click a stop to remove"
          onPointerDown={(e) => {
            // Clicks on a stop handle are caught by the handle (stopPropagation);
            // a bare bar click adds a stop here.
            const pos = posFromClientX(e.clientX);
            addStopAt(pos);
          }}
          className="h-5 w-44 cursor-copy rounded border border-edge"
          style={{
            backgroundImage: `${previewCss}, linear-gradient(45deg, #555 25%, transparent 25%, transparent 75%, #555 75%), linear-gradient(45deg, #555 25%, transparent 25%, transparent 75%, #555 75%)`,
            backgroundSize: "auto, 6px 6px, 6px 6px",
            backgroundPosition: "0 0, 0 0, 3px 3px",
          }}
        />
        {/* Stop handles (positioned by pos; reverse flips visual placement). */}
        {stops.map((s, i) => {
          const left = (reverse ? 1 - s.pos : s.pos) * 100;
          return (
            <button
              key={i}
              type="button"
              title={`Stop ${Math.round(s.pos * 100)}% · click to recolor · double-click to remove`}
              onPointerDown={(e) => {
                e.stopPropagation();
                setSelected(i);
                dragRef.current = { index: i, moved: false };
              }}
              onClick={(e) => {
                e.stopPropagation();
                // A plain click (no drag) opens the color picker for this stop.
                if (!dragRef.current?.moved) {
                  setSelected(i);
                  setPickerOpen((o) => (sel === i ? !o : true));
                }
              }}
              onDoubleClick={(e) => {
                e.stopPropagation();
                removeStop(i);
              }}
              className={`absolute top-full -mt-0.5 h-3 w-3 -translate-x-1/2 rounded-sm border ${
                sel === i ? "border-accent ring-1 ring-accent" : "border-white"
              }`}
              style={{
                left: `${left}%`,
                backgroundColor: rgbaCss(s.color),
                boxShadow: "0 0 0 1px rgba(0,0,0,0.6)",
              }}
            />
          );
        })}
        {pickerOpen && (
          <div
            className="absolute left-0 top-full z-50 mt-3"
            onPointerDown={(e) => e.stopPropagation()}
          >
            <ColorPicker
              value={selStop.color}
              onChange={(c) => recolor(sel, c)}
            />
          </div>
        )}
      </div>
    </div>
  );
}

/** Gradient-tool option bar: type + reverse + the multi-stop editor. */
function GradientBar() {
  const { type, stops, reverse } = useGradientParams();
  return (
    <div className="flex items-center gap-3">
      <Segmented<"linear" | "radial">
        options={[
          { id: "linear", label: "Linear" },
          { id: "radial", label: "Radial" },
        ]}
        value={type}
        onChange={(t) => actions.setGradient({ type: t })}
      />
      <Checkbox
        label="Reverse"
        checked={reverse}
        title="Flip the ramp direction on apply"
        onChange={(r) => actions.setGradient({ reverse: r })}
      />
      <GradientEditor stops={stops} reverse={reverse} />
      <span className="text-[11px] text-muted">
        Drag the canvas to draw · Shift constrains the angle to 45°
      </span>
    </div>
  );
}

/**
 * Persistent right-aligned View toggles: Rulers / Grid / Snap. Wired directly to
 * the engine setters; reads the reactive useViewExtras() so the toggles reflect
 * external changes (View menu, project load).
 */
function ViewToggles() {
  const { rulersVisible, grid, snapEnabled } = useViewExtras();
  return (
    <div className="ml-auto flex items-center gap-3 border-l border-edge pl-3">
      <Checkbox
        label="Rulers"
        checked={rulersVisible}
        title="Show document rulers (drag from a ruler to pull a guide)"
        onChange={(v) => actions.setRulersVisible(v)}
      />
      <Checkbox
        label="Grid"
        checked={grid.visible}
        title="Show the alignment grid"
        onChange={(v) => actions.setGridVisible(v)}
      />
      <Checkbox
        label="Snap"
        checked={snapEnabled}
        title="Snap moves/marquees/shapes to guides, grid, edges and center"
        onChange={(v) => actions.setSnapEnabled(v)}
      />
    </div>
  );
}

export function ToolOptions() {
  const { active, brush, feather, foreground } = useToolState();
  // The retouch brushes report as paint tools (shared gesture path) but have
  // their own option bars, so the generic brush bar must exclude them.
  const paint = isPaintTool(active) && !isRetouchTool(active);
  const sel = isSelectionTool(active);

  return (
    <div className="flex items-center gap-4 border-b border-edge bg-panel px-3 py-1.5">
      <span className="text-[11px] font-semibold uppercase tracking-wider text-muted">
        {active.replace("-", " ")}
      </span>

      {paint && (
        <div className="flex items-center gap-4">
          <Slider
            label="Size"
            value={brush.size}
            min={1}
            max={512}
            step={1}
            fmt={(v) => `${Math.round(v)}px`}
            onChange={(v) => toolStore.setBrush({ size: v })}
          />
          <Slider
            label="Opacity"
            value={brush.opacity}
            min={0}
            max={1}
            step={0.01}
            fmt={(v) => `${Math.round(v * 100)}%`}
            onChange={(v) => toolStore.setBrush({ opacity: v })}
          />
          <Slider
            label="Hardness"
            value={brush.hardness}
            min={0}
            max={1}
            step={0.01}
            fmt={(v) => `${Math.round(v * 100)}%`}
            onChange={(v) => toolStore.setBrush({ hardness: v })}
          />
          <Slider
            label="Flow"
            value={brush.flow}
            min={0.01}
            max={1}
            step={0.01}
            fmt={(v) => `${Math.round(v * 100)}%`}
            onChange={(v) => toolStore.setBrush({ flow: v })}
          />
          {/* Advanced shape dynamics + saved presets (self-mounted popovers). */}
          <BrushDynamicsButton />
          <BrushPresetsButton />
        </div>
      )}

      {sel && (
        <div className="flex items-center gap-4">
          <Slider
            label="Feather"
            value={feather}
            min={0}
            max={32}
            step={1}
            fmt={(v) => `${Math.round(v)}px`}
            onChange={(v) => toolStore.setFeather(v)}
          />
          <span className="text-[11px] text-muted">Shift add · Alt subtract</span>
          <button className="btn" onClick={() => actions.selectAll()}>
            Select all
          </button>
          <button className="btn" onClick={() => actions.clearSelection()}>
            Deselect
          </button>
        </div>
      )}

      {active === "bucket" && (
        <div className="flex items-center gap-2">
          <span className="text-[11px] text-muted">Fill with</span>
          <ColorChip color={foreground} title="Foreground color" />
          <span className="text-[11px] text-muted">
            Fills the selection, or the whole layer when nothing is selected
          </span>
          {/* Pattern fill affordance: same picker popover used by the stamp. */}
          <span className="ml-2 border-l border-edge pl-2 text-[11px] text-muted">
            or
          </span>
          <PatternsButton label="Fill with Pattern" />
        </div>
      )}

      {active === "gradient" && <GradientBar />}

      {active === "pattern-stamp" && <PatternStampBar />}

      {active === "eyedropper" && (
        <span className="text-[11px] text-muted">
          Click the canvas to sample a color into the foreground
        </span>
      )}

      {active === "move" && (
        <>
          <span className="text-[11px] text-muted">
            Drag to move the active layer · Space to pan
          </span>
          {/* If the active layer is text, expose its path/warp here too. */}
          <TextPathWarpControls />
        </>
      )}
      {active === "hand" && (
        <span className="text-[11px] text-muted">Drag to pan · scroll to zoom</span>
      )}

      {active === "transform" && <TransformBar />}
      {active === "crop" && <CropBar />}
      {active === "text" && <TextBar />}
      {active === "shape" && <ShapeBar />}
      {active === "pen" && (
        <>
          <PenBar />
          {/* Bind the active text layer to the path you just drew, in place. */}
          <TextPathWarpControls />
        </>
      )}

      {/* Magic wand + AI Magic Select + retouch brushes. */}
      {active === "magic-wand" && <MagicWandBar />}
      {active === "sam-select" && <SamSelectBar />}
      {active === "clone" && <CloneBar heal={false} />}
      {active === "heal" && <CloneBar heal={true} />}
      {active === "dodge" && <DodgeBurnBar burn={false} />}
      {active === "burn" && <DodgeBurnBar burn={true} />}
      {active === "smudge" && <SmudgeBar />}
      {active === "blur-brush" && <FocusBar sharpen={false} />}
      {active === "sharpen-brush" && <FocusBar sharpen={true} />}

      {/* Persistent right-aligned View toggles (Rulers / Grid / Snap). */}
      <ViewToggles />
    </div>
  );
}
