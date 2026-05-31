/**
 * NewDocumentDialog — a modal to create a NEW document (a new tab) at a chosen
 * size and background.
 *
 * Routes through the engine's multi-document API only (it never touches pixels):
 *   - "Transparent" → engine.newDocument({ width, height }) (a blank, layer-less
 *     document of that size).
 *   - "White" / "Background color" → engine.openImageAsDocument(imageData) with a
 *     solid-filled ImageData of the chosen size, which sizes the doc to the image
 *     and adds a single filled raster layer (the existing image-open path).
 *
 * Presets cover common canvas sizes; "Custom" reveals editable W×H fields. The
 * dialog mirrors ExportDialog's dark Tailwind chrome + Escape/Enter handling and
 * is self-contained: the parent mounts it and unmounts on close.
 */
import { useEffect, useState } from "react";
import { actions } from "../state/useEngine";

interface NewDocumentDialogProps {
  /** Close the dialog (parent unmounts it). */
  onClose: () => void;
}

type Background = "transparent" | "white" | "color";

interface Preset {
  label: string;
  width: number;
  height: number;
}

/** Common starting canvas sizes. */
const PRESETS: Preset[] = [
  { label: "Square 1024", width: 1024, height: 1024 },
  { label: "Square 2048", width: 2048, height: 2048 },
  { label: "HD 1920×1080", width: 1920, height: 1080 },
  { label: "4K 3840×2160", width: 3840, height: 2160 },
  { label: "Portrait 1080×1350", width: 1080, height: 1350 },
  { label: "Story 1080×1920", width: 1080, height: 1920 },
  { label: "A4 @150dpi", width: 1240, height: 1754 },
];

const MAX_DIM = 16384;

/** Build a solid-filled ImageData (top-down RGBA8) of the given size + color. */
function makeSolidImageData(
  width: number,
  height: number,
  r: number,
  g: number,
  b: number,
  a: number,
): ImageData {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < data.length; i += 4) {
    data[i] = r;
    data[i + 1] = g;
    data[i + 2] = b;
    data[i + 3] = a;
  }
  return new ImageData(data, width, height);
}

/** Parse a #rrggbb hex string to 0..255 components (defaults to white on junk). */
function hexToRgb(hex: string): { r: number; g: number; b: number } {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return { r: 255, g: 255, b: 255 };
  const n = parseInt(m[1]!, 16);
  return { r: (n >> 16) & 0xff, g: (n >> 8) & 0xff, b: n & 0xff };
}

export function NewDocumentDialog({ onClose }: NewDocumentDialogProps) {
  const [presetIdx, setPresetIdx] = useState(0); // -1 = custom
  const [width, setWidth] = useState(PRESETS[0]!.width);
  const [height, setHeight] = useState(PRESETS[0]!.height);
  const [background, setBackground] = useState<Background>("transparent");
  const [color, setColor] = useState("#ffffff");
  const [busy, setBusy] = useState(false);

  const w = Math.max(1, Math.min(MAX_DIM, Math.round(width)));
  const h = Math.max(1, Math.min(MAX_DIM, Math.round(height)));
  const valid = w >= 1 && h >= 1;

  function pickPreset(idx: number) {
    setPresetIdx(idx);
    if (idx >= 0) {
      setWidth(PRESETS[idx]!.width);
      setHeight(PRESETS[idx]!.height);
    }
  }

  async function onCreate() {
    if (busy || !valid) return;
    setBusy(true);
    try {
      if (background === "transparent") {
        actions.newDocument({ width: w, height: h, title: "Untitled" });
      } else {
        const { r, g, b } =
          background === "white" ? { r: 255, g: 255, b: 255 } : hexToRgb(color);
        const img = makeSolidImageData(w, h, r, g, b, 255);
        await actions.openImageAsDocument(img, "Untitled");
      }
      onClose();
    } finally {
      setBusy(false);
    }
  }

  // Escape cancels, Enter confirms (when not editing inside the picker, which
  // swallows Enter on its own; the window-level handler is a convenience).
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      } else if (e.key === "Enter" && !busy) {
        e.preventDefault();
        void onCreate();
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [w, h, background, color, busy]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="w-80 overflow-hidden rounded-lg border border-edge bg-panel shadow-2xl">
        <div className="panel-title border-b border-edge">New Document</div>

        <div className="flex flex-col gap-3 p-3">
          {/* Preset select. */}
          <label className="flex flex-col gap-1.5">
            <span className="text-xs text-muted">Preset</span>
            <select
              className="rounded-md border border-edge bg-panelraised px-2 py-1 text-xs text-ink"
              value={presetIdx}
              onChange={(e) => pickPreset(Number(e.target.value))}
            >
              {PRESETS.map((p, i) => (
                <option key={p.label} value={i}>
                  {p.label}
                </option>
              ))}
              <option value={-1}>Custom…</option>
            </select>
          </label>

          {/* Width × Height. Editing either field switches to "Custom". */}
          <div className="flex gap-2">
            <label className="flex flex-1 flex-col gap-1">
              <span className="text-xs text-muted">Width</span>
              <input
                type="number"
                min={1}
                max={MAX_DIM}
                value={width}
                onChange={(e) => {
                  setWidth(Number(e.target.value));
                  setPresetIdx(-1);
                }}
                className="w-full rounded-md border border-edge bg-panelraised px-2 py-1 text-xs tabular-nums text-ink"
              />
            </label>
            <label className="flex flex-1 flex-col gap-1">
              <span className="text-xs text-muted">Height</span>
              <input
                type="number"
                min={1}
                max={MAX_DIM}
                value={height}
                onChange={(e) => {
                  setHeight(Number(e.target.value));
                  setPresetIdx(-1);
                }}
                className="w-full rounded-md border border-edge bg-panelraised px-2 py-1 text-xs tabular-nums text-ink"
              />
            </label>
          </div>

          {/* Background. */}
          <label className="flex flex-col gap-1.5">
            <span className="text-xs text-muted">Background</span>
            <div className="flex gap-1">
              {(
                [
                  { value: "transparent", label: "Transparent" },
                  { value: "white", label: "White" },
                  { value: "color", label: "Color" },
                ] as { value: Background; label: string }[]
              ).map((b) => (
                <button
                  key={b.value}
                  className={`flex-1 rounded-md border px-2 py-1 text-xs transition-colors ${
                    background === b.value
                      ? "border-accent bg-accent/20 text-ink"
                      : "border-edge bg-panelraised text-muted hover:text-ink"
                  }`}
                  onClick={() => setBackground(b.value)}
                >
                  {b.label}
                </button>
              ))}
            </div>
          </label>

          {/* Color swatch (only when "Color" is the chosen background). */}
          {background === "color" && (
            <label className="flex items-center justify-between gap-2">
              <span className="text-xs text-muted">Fill color</span>
              <input
                type="color"
                value={color}
                onChange={(e) => setColor(e.target.value)}
                className="h-7 w-12 cursor-pointer rounded border border-edge bg-panelraised"
              />
            </label>
          )}

          <p className="text-[11px] leading-relaxed text-muted">
            {w} × {h} px · opens as a new tab
            {background === "transparent"
              ? " · empty (no layers)."
              : " · one filled background layer."}
          </p>
        </div>

        <div className="flex items-center justify-end gap-1.5 border-t border-edge p-2">
          <button className="btn" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button
            className="btn btn-accent"
            onClick={onCreate}
            disabled={busy || !valid}
          >
            {busy ? "Creating…" : "Create"}
          </button>
        </div>
      </div>
    </div>
  );
}
