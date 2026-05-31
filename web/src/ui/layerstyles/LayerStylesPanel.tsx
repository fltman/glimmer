/**
 * LayerStylesPanel — the non-destructive "Layer Styles" (fx) editor for a single
 * pixel layer (raster / text). It edits the layer's `effects` bag through the
 * engine: each control updates LIVE via `actions.updateLayerEffect` (no per-tick
 * undo) and records ONE undo step on release / commit via
 * `actions.commitLayerEffects`, passing the effects bag captured when the panel
 * opened (or when the gesture began).
 *
 * Effects exposed (matching the engine's DEFAULT_EFFECTS shapes):
 *   Drop Shadow  — color / opacity / angle / distance / size
 *   Stroke       — color / width / position
 *   Outer Glow   — color / opacity / size
 *   Color Overlay— color / opacity / blend mode
 *
 * The panel is rendered as a modal overlay by the LayersPanel; it never touches
 * pixels and only reads/writes through the engine.
 */
import { useCallback, useRef, useState } from "react";
import {
  BLEND_MODE_LABELS,
  type BlendMode,
  type LayerEffects,
  type LayerEffectType,
  type TextColor,
} from "../../model/Document";
import { actions, engine } from "../../state/useEngine";
import { hexToRgba, rgbaToHex } from "../adjustments/colorUtil";

export interface LayerStylesPanelProps {
  layerId: string;
  layerName: string;
  onClose: () => void;
}

/** Read the layer's current effects bag straight from the engine doc. */
function readEffects(id: string): LayerEffects {
  return engine.getLayerEffects(id) ?? {};
}

export function LayerStylesPanel({ layerId, layerName, onClose }: LayerStylesPanelProps) {
  // Effects snapshot captured when the editor opened — the "prev" for the single
  // undo step recorded when the panel closes (or after each atomic toggle).
  const openSnapshot = useRef<LayerEffects>(readEffects(layerId));
  // Effects captured at the start of a slider/color drag for one-step commits.
  const gestureStart = useRef<LayerEffects | null>(null);
  // Local mirror so the controls re-render immediately as values change.
  const [fx, setFx] = useState<LayerEffects>(() => structuredClone(readEffects(layerId)));

  const refresh = useCallback(() => {
    setFx(structuredClone(readEffects(layerId)));
  }, [layerId]);

  // ── live update + one-step commit helpers ──
  const update = useCallback(
    (type: LayerEffectType, patch: Record<string, unknown>) => {
      actions.updateLayerEffect(layerId, type, patch);
      refresh();
    },
    [layerId, refresh],
  );

  const beginGesture = useCallback(() => {
    if (gestureStart.current === null) {
      gestureStart.current = structuredClone(readEffects(layerId));
    }
  }, [layerId]);

  const commitGesture = useCallback(() => {
    const prev = gestureStart.current;
    gestureStart.current = null;
    if (!prev) return;
    const next = structuredClone(readEffects(layerId));
    actions.commitLayerEffects(layerId, prev, next);
    // The open-snapshot stays as-is so closing without further edits is a no-op;
    // each committed gesture is already its own undo step.
    openSnapshot.current = next;
    refresh();
  }, [layerId, refresh]);

  /** Atomic change (toggle / select / number field) — one undo step immediately. */
  const commitAtomic = useCallback(
    (type: LayerEffectType, patch: Record<string, unknown>) => {
      const prev = structuredClone(readEffects(layerId));
      actions.updateLayerEffect(layerId, type, patch);
      const next = structuredClone(readEffects(layerId));
      actions.commitLayerEffects(layerId, prev, next);
      openSnapshot.current = next;
      refresh();
    },
    [layerId, refresh],
  );

  function close() {
    // Any pending gesture is committed defensively, then close.
    if (gestureStart.current) commitGesture();
    onClose();
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
      onClick={close}
    >
      <div
        className="flex max-h-[80vh] w-[340px] flex-col overflow-hidden rounded-lg border border-edge bg-panel shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-edge px-3 py-2">
          <div className="min-w-0">
            <div className="text-xs font-semibold text-ink">Layer Styles</div>
            <div className="truncate text-[10px] text-muted">{layerName}</div>
          </div>
          <button
            className="rounded px-1.5 py-0.5 text-muted hover:text-ink"
            onClick={close}
            title="Close"
          >
            ✕
          </button>
        </div>

        <div className="flex-1 overflow-y-auto px-3 py-3">
          <div className="flex flex-col gap-3">
            <DropShadowSection
              effect={fx.dropShadow}
              onToggle={(enabled) =>
                commitAtomic("dropShadow", { enabled })
              }
              onUpdate={(patch) => update("dropShadow", patch)}
              onBegin={beginGesture}
              onCommit={commitGesture}
              onCommitAtomic={(patch) => commitAtomic("dropShadow", patch)}
            />
            <StrokeSection
              effect={fx.stroke}
              onToggle={(enabled) => commitAtomic("stroke", { enabled })}
              onUpdate={(patch) => update("stroke", patch)}
              onBegin={beginGesture}
              onCommit={commitGesture}
              onCommitAtomic={(patch) => commitAtomic("stroke", patch)}
            />
            <OuterGlowSection
              effect={fx.outerGlow}
              onToggle={(enabled) => commitAtomic("outerGlow", { enabled })}
              onUpdate={(patch) => update("outerGlow", patch)}
              onBegin={beginGesture}
              onCommit={commitGesture}
              onCommitAtomic={(patch) => commitAtomic("outerGlow", patch)}
            />
            <ColorOverlaySection
              effect={fx.colorOverlay}
              onToggle={(enabled) => commitAtomic("colorOverlay", { enabled })}
              onUpdate={(patch) => update("colorOverlay", patch)}
              onBegin={beginGesture}
              onCommit={commitGesture}
              onCommitAtomic={(patch) => commitAtomic("colorOverlay", patch)}
            />
          </div>
        </div>

        <div className="flex items-center justify-end gap-2 border-t border-edge px-3 py-2">
          <button className="btn-accent btn" onClick={close}>
            Done
          </button>
        </div>
      </div>
    </div>
  );
}

// ── shared section chrome ─────────────────────────────────────
function Section({
  title,
  enabled,
  onToggle,
  children,
}: {
  title: string;
  enabled: boolean;
  onToggle: (enabled: boolean) => void;
  children: React.ReactNode;
}) {
  return (
    <div className="rounded-md border border-edge bg-panelraised">
      <label className="flex cursor-pointer items-center gap-2 px-2.5 py-2">
        <input
          type="checkbox"
          checked={enabled}
          onChange={(e) => onToggle(e.target.checked)}
          className="accent-accent"
        />
        <span className={`text-[12px] font-semibold ${enabled ? "text-ink" : "text-muted"}`}>
          {title}
        </span>
      </label>
      {enabled && <div className="flex flex-col gap-2.5 border-t border-edge px-2.5 py-2.5">{children}</div>}
    </div>
  );
}

const BLACK: TextColor = { r: 0, g: 0, b: 0, a: 1 };

/** A labelled color swatch row. Commits as one atomic undo step on change. */
function ColorRow({
  label,
  value,
  onChange,
}: {
  label: string;
  value: TextColor;
  onChange: (c: TextColor) => void;
}) {
  return (
    <label className="flex items-center justify-between">
      <span className="text-[11px] text-muted">{label}</span>
      <input
        type="color"
        value={rgbaToHex(value)}
        onChange={(e) => onChange(hexToRgba(e.target.value, value.a))}
        className="h-6 w-10 cursor-pointer rounded border border-edge bg-panelraised"
      />
    </label>
  );
}

/** A labelled slider with a numeric readout. Live updates + gesture commit. */
function SliderRow({
  label,
  value,
  min,
  max,
  step,
  unit,
  onBegin,
  onUpdate,
  onCommit,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  unit?: string;
  onBegin: () => void;
  onUpdate: (v: number) => void;
  onCommit: () => void;
}) {
  return (
    <label className="flex flex-col gap-1">
      <div className="flex items-center justify-between">
        <span className="text-[11px] text-muted">{label}</span>
        <span className="text-[11px] tabular-nums text-muted">
          {step < 1 ? Number(value.toFixed(2)) : Math.round(value)}
          {unit}
        </span>
      </div>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onPointerDown={onBegin}
        onChange={(e) => onUpdate(Number(e.target.value))}
        onPointerUp={onCommit}
        onKeyDown={onBegin}
        onKeyUp={onCommit}
      />
    </label>
  );
}

// ── per-effect sections ───────────────────────────────────────
function DropShadowSection({
  effect,
  onToggle,
  onUpdate,
  onBegin,
  onCommit,
  onCommitAtomic,
}: {
  effect: LayerEffects["dropShadow"];
  onToggle: (enabled: boolean) => void;
  onUpdate: (patch: Record<string, unknown>) => void;
  onBegin: () => void;
  onCommit: () => void;
  onCommitAtomic: (patch: Record<string, unknown>) => void;
}) {
  const enabled = !!effect?.enabled;
  const color = effect?.color ?? BLACK;
  const opacity = effect?.opacity ?? 0.5;
  const angle = effect?.angle ?? 135;
  const distance = effect?.distance ?? 8;
  const size = effect?.size ?? 8;
  return (
    <Section title="Drop Shadow" enabled={enabled} onToggle={onToggle}>
      <ColorRow label="Color" value={color} onChange={(c) => onCommitAtomic({ color: c })} />
      <SliderRow
        label="Opacity"
        value={opacity}
        min={0}
        max={1}
        step={0.01}
        onBegin={onBegin}
        onUpdate={(v) => onUpdate({ opacity: v })}
        onCommit={onCommit}
      />
      <SliderRow
        label="Angle"
        value={angle}
        min={0}
        max={360}
        step={1}
        unit="°"
        onBegin={onBegin}
        onUpdate={(v) => onUpdate({ angle: v })}
        onCommit={onCommit}
      />
      <SliderRow
        label="Distance"
        value={distance}
        min={0}
        max={100}
        step={1}
        unit="px"
        onBegin={onBegin}
        onUpdate={(v) => onUpdate({ distance: v })}
        onCommit={onCommit}
      />
      <SliderRow
        label="Size"
        value={size}
        min={0}
        max={100}
        step={1}
        unit="px"
        onBegin={onBegin}
        onUpdate={(v) => onUpdate({ size: v })}
        onCommit={onCommit}
      />
    </Section>
  );
}

function StrokeSection({
  effect,
  onToggle,
  onUpdate,
  onBegin,
  onCommit,
  onCommitAtomic,
}: {
  effect: LayerEffects["stroke"];
  onToggle: (enabled: boolean) => void;
  onUpdate: (patch: Record<string, unknown>) => void;
  onBegin: () => void;
  onCommit: () => void;
  onCommitAtomic: (patch: Record<string, unknown>) => void;
}) {
  const enabled = !!effect?.enabled;
  const color = effect?.color ?? BLACK;
  const width = effect?.width ?? 3;
  const position = effect?.position ?? "outside";
  return (
    <Section title="Stroke" enabled={enabled} onToggle={onToggle}>
      <ColorRow label="Color" value={color} onChange={(c) => onCommitAtomic({ color: c })} />
      <SliderRow
        label="Width"
        value={width}
        min={1}
        max={100}
        step={1}
        unit="px"
        onBegin={onBegin}
        onUpdate={(v) => onUpdate({ width: v })}
        onCommit={onCommit}
      />
      <label className="flex items-center justify-between">
        <span className="text-[11px] text-muted">Position</span>
        <select
          value={position}
          onChange={(e) => onCommitAtomic({ position: e.target.value })}
          className="rounded border border-edge bg-panelraised px-1.5 py-1 text-[11px] outline-none focus:border-accent"
        >
          <option value="outside">Outside</option>
          <option value="inside">Inside</option>
          <option value="center">Center</option>
        </select>
      </label>
    </Section>
  );
}

function OuterGlowSection({
  effect,
  onToggle,
  onUpdate,
  onBegin,
  onCommit,
  onCommitAtomic,
}: {
  effect: LayerEffects["outerGlow"];
  onToggle: (enabled: boolean) => void;
  onUpdate: (patch: Record<string, unknown>) => void;
  onBegin: () => void;
  onCommit: () => void;
  onCommitAtomic: (patch: Record<string, unknown>) => void;
}) {
  const enabled = !!effect?.enabled;
  const color = effect?.color ?? { r: 1, g: 1, b: 0.6, a: 1 };
  const opacity = effect?.opacity ?? 0.6;
  const size = effect?.size ?? 12;
  return (
    <Section title="Outer Glow" enabled={enabled} onToggle={onToggle}>
      <ColorRow label="Color" value={color} onChange={(c) => onCommitAtomic({ color: c })} />
      <SliderRow
        label="Opacity"
        value={opacity}
        min={0}
        max={1}
        step={0.01}
        onBegin={onBegin}
        onUpdate={(v) => onUpdate({ opacity: v })}
        onCommit={onCommit}
      />
      <SliderRow
        label="Size"
        value={size}
        min={0}
        max={100}
        step={1}
        unit="px"
        onBegin={onBegin}
        onUpdate={(v) => onUpdate({ size: v })}
        onCommit={onCommit}
      />
    </Section>
  );
}

function ColorOverlaySection({
  effect,
  onToggle,
  onUpdate,
  onBegin,
  onCommit,
  onCommitAtomic,
}: {
  effect: LayerEffects["colorOverlay"];
  onToggle: (enabled: boolean) => void;
  onUpdate: (patch: Record<string, unknown>) => void;
  onBegin: () => void;
  onCommit: () => void;
  onCommitAtomic: (patch: Record<string, unknown>) => void;
}) {
  const enabled = !!effect?.enabled;
  const color = effect?.color ?? { r: 1, g: 0, b: 0, a: 1 };
  const opacity = effect?.opacity ?? 1;
  const blendMode = effect?.blendMode ?? "normal";
  return (
    <Section title="Color Overlay" enabled={enabled} onToggle={onToggle}>
      <ColorRow label="Color" value={color} onChange={(c) => onCommitAtomic({ color: c })} />
      <SliderRow
        label="Opacity"
        value={opacity}
        min={0}
        max={1}
        step={0.01}
        onBegin={onBegin}
        onUpdate={(v) => onUpdate({ opacity: v })}
        onCommit={onCommit}
      />
      <label className="flex items-center justify-between">
        <span className="text-[11px] text-muted">Blend</span>
        <select
          value={blendMode}
          onChange={(e) => onCommitAtomic({ blendMode: e.target.value as BlendMode })}
          className="rounded border border-edge bg-panelraised px-1.5 py-1 text-[11px] outline-none focus:border-accent"
        >
          {BLEND_MODE_LABELS.map((b) => (
            <option key={b.mode} value={b.mode}>
              {b.label}
            </option>
          ))}
        </select>
      </label>
    </Section>
  );
}
