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
  type RGBAColor,
  type ShapeKind,
} from "../state/tools";
import { actions, engine, useEngineSnapshot } from "../state/useEngine";
import { ColorPicker } from "./color/ColorPicker";
import { rgbaCss } from "./color/colorMath";

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
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  fmt: (v: number) => string;
  onChange: (v: number) => void;
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

/**
 * Type-tool option bar. Edits the tool-store defaults for NEW text layers (and,
 * when a text layer is being edited, the engine separately mirrors these into
 * the live layer via updateTextLayer — wired in CanvasHost's textarea overlay).
 * `color` is the explicit per-tool color, or null to follow the foreground.
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

export function ToolOptions() {
  const { active, brush, feather, foreground, background } = useToolState();
  const paint = isPaintTool(active);
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
        </div>
      )}

      {active === "gradient" && (
        <div className="flex items-center gap-2">
          <span className="text-[11px] text-muted">Linear</span>
          <ColorChip color={foreground} title="Foreground (start)" />
          <span className="text-[11px] text-muted">→</span>
          <ColorChip color={background} title="Background (end)" />
          <span className="text-[11px] text-muted">
            Drag to draw · Shift constrains the angle to 45°
          </span>
        </div>
      )}

      {active === "eyedropper" && (
        <span className="text-[11px] text-muted">
          Click the canvas to sample a color into the foreground
        </span>
      )}

      {active === "move" && (
        <span className="text-[11px] text-muted">
          Drag to move the active layer · Space to pan
        </span>
      )}
      {active === "hand" && (
        <span className="text-[11px] text-muted">Drag to pan · scroll to zoom</span>
      )}

      {active === "transform" && <TransformBar />}
      {active === "crop" && <CropBar />}
      {active === "text" && <TextBar />}
      {active === "shape" && <ShapeBar />}
    </div>
  );
}
