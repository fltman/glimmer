/**
 * AdjustmentProperties — the editable parameter panel for the active adjustment
 * layer, rendered data-driven from the registry's `paramsSchema`. Each control
 * updates live via `engine.updateAdjustmentParams` and records ONE undo step on
 * release via `commitAdjustmentParams`, passing the params snapshot captured when
 * the gesture began.
 *
 * `curves` and `levels` get their dedicated interactive editors instead of the
 * raw curve/slider fields.
 */
import { useCallback, useRef } from "react";
import type { LayerSnapshot } from "../../model/Document";
import { actions, engine } from "../../state/useEngine";
import { ADJUSTMENTS, type ParamField, type GradientStop } from "../../engine/adjustments";
import { CurvesEditor } from "./CurvesEditor";
import { LevelsEditor } from "./LevelsEditor";
import { GradientStopsEditor } from "./GradientStopsEditor";
import { hexToRgba, rgbaToHex, type RGBA } from "./colorUtil";

export interface AdjustmentPropertiesProps {
  layer: LayerSnapshot; // an adjustment layer (kind === "adjustment")
}

function num(v: unknown, fallback: number): number {
  return typeof v === "number" && Number.isFinite(v) ? v : fallback;
}
function bool(v: unknown, fallback: boolean): boolean {
  return typeof v === "boolean" ? v : fallback;
}
function str(v: unknown, fallback: string): string {
  return typeof v === "string" ? v : fallback;
}

export function AdjustmentProperties({ layer }: AdjustmentPropertiesProps) {
  const id = layer.id;
  const type = layer.adjustmentType!;
  const def = ADJUSTMENTS[type];
  const params = (layer.params ?? {}) as Record<string, unknown>;

  // Params captured at the start of a gesture so the whole drag is one undo step.
  const gestureStart = useRef<Record<string, unknown> | null>(null);

  const beginGesture = useCallback(() => {
    if (gestureStart.current === null) {
      gestureStart.current = structuredClone(params);
    }
  }, [params]);

  const update = useCallback(
    (patch: Record<string, unknown>) => {
      actions.updateAdjustmentParams(id, patch);
    },
    [id],
  );

  const commit = useCallback(() => {
    const prev = gestureStart.current;
    gestureStart.current = null;
    if (!prev) return;
    // Read the latest params straight from the engine doc so the commit captures
    // the final values (the snapshot prop may lag a tick behind).
    const node = engine.doc.getLayer(id);
    const next =
      node && node.kind === "adjustment"
        ? structuredClone(node.params)
        : structuredClone(params);
    actions.commitAdjustmentParams(id, prev, next);
  }, [id, params]);

  function reset() {
    const prev = structuredClone(params);
    const defaults = structuredClone(def.defaults);
    actions.commitAdjustmentParams(id, prev, defaults);
  }

  // ── dedicated editors ───────────────────────────────────
  if (type === "curves") {
    return (
      <PropsShell label={def.label} onReset={reset}>
        <CurvesEditor
          params={params}
          onChange={(next) => update(next as Record<string, unknown>)}
          onCommit={() => {
            // Curves edits arrive as full param objects; record one step.
            const prev = gestureStart.current ?? structuredClone(params);
            gestureStart.current = null;
            const node = engine.doc.getLayer(id);
            const final =
              node && node.kind === "adjustment"
                ? structuredClone(node.params)
                : structuredClone(params);
            actions.commitAdjustmentParams(id, prev, final);
          }}
        />
        <ClippingToggle layer={layer} />
      </PropsShell>
    );
  }

  if (type === "levels") {
    return (
      <PropsShell label={def.label} onReset={reset}>
        <LevelsEditor
          params={params}
          histogram={histogramBelow(id)}
          onChange={(patch) => {
            beginGesture();
            update(patch);
          }}
          onCommit={commit}
        />
        <ClippingToggle layer={layer} />
      </PropsShell>
    );
  }

  // ── generic data-driven fields ──────────────────────────
  return (
    <PropsShell label={def.label} onReset={reset}>
      <div className="flex flex-col gap-2.5">
        {def.paramsSchema.map((field) => (
          <FieldControl
            key={field.key}
            field={field}
            params={params}
            onBegin={beginGesture}
            onUpdate={update}
            onCommit={commit}
          />
        ))}
        {def.paramsSchema.length === 0 && (
          <p className="text-[11px] text-muted">No parameters — applies directly.</p>
        )}
      </div>
      <ClippingToggle layer={layer} />
    </PropsShell>
  );
}

// Histogram of the raster layer immediately below this adjustment (what it acts
// on). Falls back to null if the layer below isn't raster.
function histogramBelow(adjustmentId: string) {
  const order = engine.doc.orderBottomToTop();
  const idx = order.indexOf(adjustmentId);
  for (let i = idx - 1; i >= 0; i--) {
    const below = engine.doc.getLayer(order[i]!);
    if (below && below.kind === "raster") {
      return actions.getLayerHistogram(below.id);
    }
  }
  return null;
}

function PropsShell({
  label,
  onReset,
  children,
}: {
  label: string;
  onReset: () => void;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-3 border-t border-edge px-3 py-3">
      <div className="flex items-center justify-between">
        <span className="text-xs font-semibold text-ink">{label}</span>
        <button
          onClick={onReset}
          className="rounded border border-edge bg-panelraised px-1.5 py-0.5 text-[10px] text-muted hover:text-ink"
          title="Reset to defaults"
        >
          Reset
        </button>
      </div>
      {children}
    </div>
  );
}

function ClippingToggle({ layer }: { layer: LayerSnapshot }) {
  return (
    <label className="flex cursor-pointer items-center gap-2 text-[11px] text-muted">
      <input
        type="checkbox"
        checked={!!layer.clipping}
        onChange={(e) => actions.setAdjustmentClipping(layer.id, e.target.checked)}
        className="accent-accent"
      />
      Clip to layer below
    </label>
  );
}

// ── individual field renderers ────────────────────────────
function FieldControl({
  field,
  params,
  onBegin,
  onUpdate,
  onCommit,
}: {
  field: ParamField;
  params: Record<string, unknown>;
  onBegin: () => void;
  onUpdate: (patch: Record<string, unknown>) => void;
  onCommit: () => void;
}) {
  switch (field.kind) {
    case "slider":
      return (
        <SliderField field={field} params={params} onBegin={onBegin} onUpdate={onUpdate} onCommit={onCommit} />
      );
    case "checkbox":
      return (
        <label className="flex cursor-pointer items-center gap-2 text-[11px] text-muted">
          <input
            type="checkbox"
            checked={bool(params[field.key], field.default)}
            onChange={(e) => {
              const prev = structuredClone(params);
              onUpdate({ [field.key]: e.target.checked });
              // Checkbox toggles are atomic — commit immediately as one step.
              actions.commitAdjustmentParams(
                currentLayerId(),
                prev,
                { ...params, [field.key]: e.target.checked },
              );
            }}
            className="accent-accent"
          />
          {field.label}
        </label>
      );
    case "select":
      return (
        <label className="flex flex-col gap-1">
          <span className="text-[11px] text-muted">{field.label}</span>
          <select
            value={str(params[field.key], field.default)}
            onChange={(e) => {
              const prev = structuredClone(params);
              onUpdate({ [field.key]: e.target.value });
              actions.commitAdjustmentParams(
                currentLayerId(),
                prev,
                { ...params, [field.key]: e.target.value },
              );
            }}
            className="rounded border border-edge bg-panelraised px-1.5 py-1 text-[11px] outline-none focus:border-accent"
          >
            {field.options.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </label>
      );
    case "color":
      return <ColorField field={field} params={params} onUpdate={onUpdate} />;
    case "gradient": {
      const raw = params[field.key];
      const stops: GradientStop[] =
        Array.isArray(raw) && raw.length >= 2 ? (raw as GradientStop[]) : field.default;
      return (
        <label className="flex flex-col gap-1.5">
          <span className="text-[11px] text-muted">{field.label}</span>
          <GradientStopsEditor
            stops={stops}
            onChange={(next) => onUpdate({ [field.key]: next })}
            onCommit={() => {
              // Gradient edits are already committed by the editor via onChange +
              // onCommit pairs; record one undo step using the latest params.
              const prev = structuredClone(params);
              const node = engine.doc.getLayer(currentLayerId());
              const final =
                node && node.kind === "adjustment"
                  ? structuredClone(node.params)
                  : structuredClone(params);
              actions.commitAdjustmentParams(currentLayerId(), prev, final);
            }}
          />
        </label>
      );
    }
    case "curve":
      // curves uses a dedicated editor at the top level; never reached here.
      return null;
    default:
      return null;
  }
}

// We need the active layer id inside checkbox/select commits without threading
// it through; the active adjustment is always the selected layer.
function currentLayerId(): string {
  return engine.doc.getActiveLayerId() ?? "";
}

function SliderField({
  field,
  params,
  onBegin,
  onUpdate,
  onCommit,
}: {
  field: Extract<ParamField, { kind: "slider" }>;
  params: Record<string, unknown>;
  onBegin: () => void;
  onUpdate: (patch: Record<string, unknown>) => void;
  onCommit: () => void;
}) {
  const value = num(params[field.key], field.default);
  const isInt = field.step >= 1;
  return (
    <label className="flex flex-col gap-1">
      <div className="flex items-center justify-between">
        <span className="text-[11px] text-muted">{field.label}</span>
        <input
          type="number"
          value={isInt ? Math.round(value) : Number(value.toFixed(3))}
          min={field.min}
          max={field.max}
          step={field.step}
          onChange={(e) => {
            const v = Number(e.target.value);
            if (!Number.isFinite(v)) return;
            const prev = structuredClone(params);
            const clamped = Math.min(field.max, Math.max(field.min, v));
            onUpdate({ [field.key]: clamped });
            actions.commitAdjustmentParams(
              currentLayerId(),
              prev,
              { ...params, [field.key]: clamped },
            );
          }}
          className="w-16 rounded border border-edge bg-panelraised px-1 py-0.5 text-right text-[11px] tabular-nums outline-none focus:border-accent"
        />
      </div>
      <input
        type="range"
        min={field.min}
        max={field.max}
        step={field.step}
        value={value}
        onPointerDown={onBegin}
        onChange={(e) => onUpdate({ [field.key]: Number(e.target.value) })}
        onPointerUp={onCommit}
        onKeyDown={onBegin}
        onKeyUp={onCommit}
      />
    </label>
  );
}

function ColorField({
  field,
  params,
  onUpdate,
}: {
  field: Extract<ParamField, { kind: "color" }>;
  params: Record<string, unknown>;
  onUpdate: (patch: Record<string, unknown>) => void;
}) {
  const raw = (params[field.key] as RGBA | undefined) ?? field.default;
  const cur: RGBA = {
    r: num(raw.r, field.default.r),
    g: num(raw.g, field.default.g),
    b: num(raw.b, field.default.b),
    a: num(raw.a, field.default.a),
  };
  return (
    <label className="flex items-center justify-between">
      <span className="text-[11px] text-muted">{field.label}</span>
      <input
        type="color"
        value={rgbaToHex(cur)}
        onChange={(e) => {
          const next = hexToRgba(e.target.value, cur.a);
          const prev = structuredClone(params);
          onUpdate({ [field.key]: next });
          actions.commitAdjustmentParams(
            currentLayerId(),
            prev,
            { ...params, [field.key]: next },
          );
        }}
        className="h-6 w-10 cursor-pointer rounded border border-edge bg-panelraised"
      />
    </label>
  );
}
