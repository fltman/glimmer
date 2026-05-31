/**
 * FilterDialog — a modal that renders a destructive filter's parameter form
 * (generated from the registry's `paramsSchema`) with a LIVE preview.
 *
 * Lifecycle (mirrors the engine's previewFilter/commitFilter/cancelFilter
 * contract):
 *   - on open / any param change: engine.previewFilter(layerId, type, params)
 *     substitutes the filtered texture into the live composite each frame.
 *   - OK   → engine.commitFilter(): bake the preview as one undo step.
 *   - Cancel / Escape / backdrop click → engine.cancelFilter(): discard.
 *
 * The dialog never touches pixels itself; it only pushes params to the engine.
 */
import { useEffect, useRef, useState } from "react";
import { actions } from "../../state/useEngine";
import {
  FILTERS,
  defaultFilterParams,
  type FilterType,
  type FilterParams,
} from "../../engine/filters";
import type { ParamField } from "../../engine/adjustments";
import type { RGBAColor } from "../../state/tools";
import { ColorPicker } from "../color/ColorPicker";
import { rgbaCss } from "../color/colorMath";

/** Any value a filter param can hold once the schema's field kinds are covered. */
type ParamValue = number | boolean | string | RGBAColor;

interface FilterDialogProps {
  /** The filter to configure. */
  type: FilterType;
  /** The raster layer the filter applies to. */
  layerId: string;
  /** Commit (OK) or discard (Cancel) — the parent unmounts the dialog. */
  onClose: () => void;
}

function num(v: unknown, fallback = 0): number {
  return typeof v === "number" && Number.isFinite(v) ? v : fallback;
}
function bool(v: unknown, fallback = false): boolean {
  return typeof v === "boolean" ? v : fallback;
}
function str(v: unknown, fallback = ""): string {
  return typeof v === "string" ? v : fallback;
}
function isColor(v: unknown): v is RGBAColor {
  return (
    typeof v === "object" &&
    v !== null &&
    typeof (v as RGBAColor).r === "number" &&
    typeof (v as RGBAColor).g === "number" &&
    typeof (v as RGBAColor).b === "number"
  );
}
function color(v: unknown, fallback: RGBAColor): RGBAColor {
  return isColor(v) ? v : fallback;
}

export function FilterDialog({ type, layerId, onClose }: FilterDialogProps) {
  const def = FILTERS[type];
  const [params, setParams] = useState<FilterParams>(() =>
    defaultFilterParams(type),
  );

  // Whether we've committed (OK) — guards the cleanup-cancel on unmount so we
  // don't cancel a freshly-committed bake.
  const committed = useRef(false);

  // Start (and keep) the live preview in sync with the params. Runs on mount
  // and on every param edit. The engine cancels any prior preview internally.
  useEffect(() => {
    actions.previewFilter(layerId, type, params);
  }, [layerId, type, params]);

  // On unmount, discard any still-active preview unless we committed it.
  useEffect(() => {
    return () => {
      if (!committed.current) actions.cancelFilter();
    };
  }, []);

  function setParam(key: string, value: ParamValue) {
    setParams((prev) => ({ ...prev, [key]: value }));
  }

  function onOk() {
    committed.current = true;
    actions.commitFilter();
    onClose();
  }

  function onCancel() {
    actions.cancelFilter();
    onClose();
  }

  // Escape cancels, Enter confirms — but not while a text/select control inside
  // the dialog (e.g. the ColorPicker's hex / RGB inputs, a select dropdown) has
  // focus, so those controls can use Enter/Escape for their own commit/close.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const el = e.target as HTMLElement | null;
      const tag = el?.tagName;
      const inField =
        tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT";
      if (e.key === "Escape") {
        if (inField) return;
        e.preventDefault();
        onCancel();
      } else if (e.key === "Enter") {
        if (inField) return;
        e.preventDefault();
        onOk();
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [params]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
      onMouseDown={(e) => {
        // Click outside the card cancels.
        if (e.target === e.currentTarget) onCancel();
      }}
    >
      <div className="w-72 overflow-hidden rounded-lg border border-edge bg-panel shadow-2xl">
        <div className="panel-title border-b border-edge">{def.label}</div>

        <div className="flex flex-col gap-3 p-3">
          {def.paramsSchema.length === 0 && (
            <p className="text-xs leading-relaxed text-muted">
              No options for this filter. Click Apply to preview and commit.
            </p>
          )}

          {def.paramsSchema.map((field) => (
            <FieldRow
              key={field.key}
              field={field}
              params={params}
              onChange={setParam}
            />
          ))}
        </div>

        <div className="flex items-center justify-end gap-1.5 border-t border-edge p-2">
          <button className="btn" onClick={onCancel}>
            Cancel
          </button>
          <button className="btn btn-accent" onClick={onOk}>
            Apply
          </button>
        </div>
      </div>
    </div>
  );
}

function FieldRow({
  field,
  params,
  onChange,
}: {
  field: ParamField;
  params: FilterParams;
  onChange: (key: string, value: ParamValue) => void;
}) {
  // Filters use slider / checkbox / select / color fields. We render the schema
  // generically; curve/gradient (adjustment-only kinds) are no-ops here.
  if (field.kind === "slider") {
    const value = num(params[field.key], field.default);
    return (
      <label className="flex flex-col gap-1">
        <div className="flex items-center justify-between">
          <span className="text-xs text-muted">{field.label}</span>
          <span className="text-[11px] tabular-nums text-muted">
            {Number.isInteger(field.step) ? Math.round(value) : value}
          </span>
        </div>
        <input
          type="range"
          min={field.min}
          max={field.max}
          step={field.step}
          value={value}
          onChange={(e) => onChange(field.key, Number(e.target.value))}
        />
      </label>
    );
  }

  if (field.kind === "checkbox") {
    const value = bool(params[field.key], field.default);
    return (
      <label className="flex cursor-pointer items-center gap-2">
        <input
          type="checkbox"
          checked={value}
          onChange={(e) => onChange(field.key, e.target.checked)}
          className="h-3.5 w-3.5 accent-accent"
        />
        <span className="text-xs text-muted">{field.label}</span>
      </label>
    );
  }

  if (field.kind === "select") {
    const value = str(params[field.key], field.default);
    return (
      <label className="flex items-center justify-between gap-2">
        <span className="text-xs text-muted">{field.label}</span>
        <select
          value={value}
          onChange={(e) => onChange(field.key, e.target.value)}
          className="flex-1 rounded border border-edge bg-panelraised px-1.5 py-1 text-[11px] text-ink outline-none focus:border-accent"
        >
          {field.options.map((opt) => (
            <option key={opt.value} value={opt.value}>
              {opt.label}
            </option>
          ))}
        </select>
      </label>
    );
  }

  if (field.kind === "color") {
    const value = color(params[field.key], field.default);
    return (
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs text-muted">{field.label}</span>
        <ColorSwatchField
          value={value}
          onChange={(c) => onChange(field.key, c)}
        />
      </div>
    );
  }

  // curve / gradient — not emitted by filters; render nothing.
  return null;
}

/**
 * A color swatch button that toggles the shared ColorPicker popover. Live
 * preview is preserved because every ColorPicker onChange flows up through
 * onChange → setParam → the previewFilter effect.
 */
function ColorSwatchField({
  value,
  onChange,
}: {
  value: RGBAColor;
  onChange: (c: RGBAColor) => void;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    function onDown(e: PointerEvent) {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    window.addEventListener("pointerdown", onDown);
    return () => window.removeEventListener("pointerdown", onDown);
  }, [open]);

  return (
    <div ref={rootRef} className="relative inline-flex">
      <button
        type="button"
        title="Choose color"
        onClick={(e) => {
          e.stopPropagation();
          setOpen((o) => !o);
        }}
        className={`h-6 w-9 rounded border border-edge ${open ? "ring-1 ring-accent" : ""}`}
        style={{ backgroundColor: rgbaCss(value) }}
      />
      {open && (
        <div
          className="absolute right-0 top-full z-50 mt-2"
          onPointerDown={(e) => e.stopPropagation()}
        >
          <ColorPicker value={value} onChange={onChange} />
        </div>
      )}
    </div>
  );
}
