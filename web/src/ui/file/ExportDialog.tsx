/**
 * ExportDialog — a modal to flatten + encode the document as a downloadable
 * image (PNG / JPEG / WebP).
 *
 * Drives the engine's export path only (it never touches pixels):
 *   engine.exportImage({ format, quality?, matte? }) → Blob
 * then triggers a browser download via a Blob URL + a synthetic <a download>.
 *
 * - PNG preserves alpha (no quality control — it's lossless).
 * - JPEG / WebP are lossy and opaque: a quality slider is shown, and a matte
 *   note explains transparent pixels are flattened onto white.
 *
 * The dialog is self-contained: the parent (FileMenu) mounts it and unmounts on
 * close. App just mounts <FileMenu/>; the dialog only appears on demand.
 */
import { useEffect, useState } from "react";
import { actions } from "../../state/useEngine";
import type { ExportFormat } from "../../engine/export";

interface ExportDialogProps {
  /** Document size (for the estimate note / output dimensions). */
  width: number;
  height: number;
  /** Close the dialog (parent unmounts it). */
  onClose: () => void;
}

const FORMATS: { value: ExportFormat; label: string; ext: string; lossy: boolean }[] = [
  { value: "png", label: "PNG", ext: "png", lossy: false },
  { value: "jpeg", label: "JPEG", ext: "jpg", lossy: true },
  { value: "webp", label: "WebP", ext: "webp", lossy: true },
];

export function ExportDialog({ width, height, onClose }: ExportDialogProps) {
  const [format, setFormat] = useState<ExportFormat>("png");
  const [quality, setQuality] = useState(92);
  const [busy, setBusy] = useState(false);

  const fmt = FORMATS.find((f) => f.value === format)!;

  async function onExport() {
    if (busy) return;
    setBusy(true);
    try {
      const blob = await actions.exportImage({
        format,
        quality: fmt.lossy ? quality / 100 : undefined,
      });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `glimmer-export.${fmt.ext}`;
      a.click();
      URL.revokeObjectURL(url);
      onClose();
    } finally {
      setBusy(false);
    }
  }

  // Escape cancels, Enter confirms.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      } else if (e.key === "Enter" && !busy) {
        e.preventDefault();
        void onExport();
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [format, quality, busy]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="w-72 overflow-hidden rounded-lg border border-edge bg-panel shadow-2xl">
        <div className="panel-title border-b border-edge">Export As…</div>

        <div className="flex flex-col gap-3 p-3">
          {/* Format select (segmented buttons). */}
          <label className="flex flex-col gap-1.5">
            <span className="text-xs text-muted">Format</span>
            <div className="flex gap-1">
              {FORMATS.map((f) => (
                <button
                  key={f.value}
                  className={`flex-1 rounded-md border px-2 py-1 text-xs transition-colors ${
                    format === f.value
                      ? "border-accent bg-accent/20 text-ink"
                      : "border-edge bg-panelraised text-muted hover:text-ink"
                  }`}
                  onClick={() => setFormat(f.value)}
                >
                  {f.label}
                </button>
              ))}
            </div>
          </label>

          {/* Quality slider (lossy formats only). */}
          {fmt.lossy && (
            <label className="flex flex-col gap-1">
              <div className="flex items-center justify-between">
                <span className="text-xs text-muted">Quality</span>
                <span className="text-[11px] tabular-nums text-muted">
                  {quality}%
                </span>
              </div>
              <input
                type="range"
                min={1}
                max={100}
                step={1}
                value={quality}
                onChange={(e) => setQuality(Number(e.target.value))}
              />
            </label>
          )}

          {/* Estimate / behavior note. */}
          <p className="text-[11px] leading-relaxed text-muted">
            {width} × {height} px ·{" "}
            {fmt.lossy
              ? "Lossy; transparent areas flattened onto white."
              : "Lossless; alpha preserved."}
          </p>
        </div>

        <div className="flex items-center justify-end gap-1.5 border-t border-edge p-2">
          <button className="btn" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button className="btn btn-accent" onClick={onExport} disabled={busy}>
            {busy ? "Exporting…" : "Export"}
          </button>
        </div>
      </div>
    </div>
  );
}
