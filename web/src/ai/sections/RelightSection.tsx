/**
 * RELIGHT — re-light the active image from a chosen direction, with a key-light
 * color and intensity, optionally relighting it INTO a described scene.
 *
 * Source: the ACTIVE raster layer's region is preferred (so the relight is
 * anchored to that layer's footprint); if the active layer isn't a raster layer
 * we fall back to the whole-document composite. On run we presign-upload the
 * exported PNG, post a `relight` job, and on success drop the result as a NEW
 * layer (non-destructive — the source stays beneath). When sourced from a raster
 * layer the result is anchored at that layer's origin; the composite fallback
 * lands at the document origin (0,0).
 *
 * Per the backend contract:
 *   - direction: one of RELIGHT_DIRECTIONS (required)
 *   - color:     #RRGGBB hex (optional; server default warm white #ffe6c0)
 *   - intensity: 0..1 (optional; server default 0.6)
 *   - backgroundPrompt: optional scene to relight into
 * The provider key stays on the server; the browser only ever sees presigned
 * URLs.
 */
import { useState } from "react";
import type {
  CreateJobRequest,
  RelightDirection,
  RelightInputs,
} from "@aips/shared-types";
import { RELIGHT_DIRECTIONS } from "@aips/shared-types";
import { idempotencyKey, presignUpload } from "../apiClient";
import { engine, actions, useEngineSnapshot } from "../../state/useEngine";
import { useAiJob } from "../useAiJob";
import { Field, JobStatus } from "../AiSectionShell";

/** The server default key-light color (warm white) — also our initial swatch. */
const DEFAULT_LIGHT_COLOR = "#ffe6c0";

/** A 3×3 directional pad layout. The center cell is the "front" (camera-side)
 *  light; "behind" (backlight) gets its own row beneath the pad. Empty slots
 *  are spacers so the four edge directions land on the compass points. */
const PAD: (RelightDirection | null)[] = [
  null, "top", null,
  "left", "front", "right",
  null, "bottom", null,
];

const DIRECTION_LABEL: Record<RelightDirection, string> = {
  left: "Left",
  right: "Right",
  top: "Top",
  bottom: "Bottom",
  front: "Front",
  behind: "Behind",
};

const DIRECTION_GLYPH: Record<RelightDirection, string> = {
  left: "←",
  right: "→",
  top: "↑",
  bottom: "↓",
  front: "◎",
  behind: "↺",
};

export function RelightSection() {
  const snap = useEngineSnapshot();
  const job = useAiJob();
  const [direction, setDirection] = useState<RelightDirection>("left");
  const [color, setColor] = useState<string>(DEFAULT_LIGHT_COLOR);
  const [intensity, setIntensity] = useState(0.6);
  const [backgroundPrompt, setBackgroundPrompt] = useState("");

  const activeId = snap.activeLayerId;
  const activeKind = activeId
    ? snap.layers.find((l) => l.id === activeId)?.kind
    : undefined;
  // We can relight a raster layer's region, or fall back to the whole composite.
  // Only block if there's literally nothing on the canvas.
  const hasContent = snap.layers.length > 0;
  const canRun = hasContent && !job.busy;

  async function onRun() {
    if (!canRun) return;
    // Pin the result to the doc active at job start (the user may switch tabs).
    const targetDocId = engine.getActiveDocumentId();

    // Prefer the active raster layer's region so the relight is anchored to its
    // footprint; otherwise relight the whole-document composite at (0,0).
    let imageBlob: Blob;
    let originX = 0;
    let originY = 0;
    let sourcedFromLayer = false;
    if (activeId && activeKind === "raster") {
      const geo = engine.getLayerGeometry(activeId);
      if (geo) {
        imageBlob = await engine.exportLayerRegionPNG(activeId, geo);
        originX = geo.x;
        originY = geo.y;
        sourcedFromLayer = true;
      } else {
        imageBlob = await actions.exportImage({ format: "png" });
      }
    } else {
      imageBlob = await actions.exportImage({ format: "png" });
    }

    const image = await presignUpload(imageBlob);

    // Only send optional fields when they diverge from the server defaults, so
    // a plain "warm front light at 60%" keeps a stable idempotency key.
    const inputs: RelightInputs = {
      image,
      direction,
      ...(color.toLowerCase() !== DEFAULT_LIGHT_COLOR ? { color } : {}),
      ...(Math.abs(intensity - 0.6) > 1e-6 ? { intensity } : {}),
      ...(backgroundPrompt.trim()
        ? { backgroundPrompt: backgroundPrompt.trim() }
        : {}),
    };
    const key = await idempotencyKey({ capability: "relight", inputs });
    const req: CreateJobRequest<"relight"> = {
      capability: "relight",
      inputs,
      qualityTier: "quality",
      idempotencyKey: key,
    };

    await job.run(req, {
      onArtifact: async (blob, art) => {
        const name =
          art.placement?.suggestedLayerName ??
          `Relit (${DIRECTION_LABEL[direction].toLowerCase()})`;
        // Anchor a layer-sourced relight back at the source origin; the backend
        // may also report a placement roi (whole image) we honor first.
        const place = art.placement?.roi
          ? { x: art.placement.roi.x, y: art.placement.roi.y }
          : sourcedFromLayer
            ? { x: originX, y: originY }
            : undefined;
        if (targetDocId) {
          await engine.placeImageOnDocument(targetDocId, blob, name, place);
        } else {
          const id = await engine.loadImageLayer(blob, name);
          if (place) engine.setLayerPosition(id, place.x, place.y);
        }
      },
    });
  }

  return (
    <div className="flex flex-col gap-3">
      <p className="text-xs leading-relaxed text-muted">
        Re-light the active image from a chosen direction — set the key-light
        color, how dramatic it is, and optionally a scene to relight into. Added
        as a new layer above the original.
      </p>

      {/* Direction pad */}
      <Field
        label={`Light from · ${DIRECTION_LABEL[direction]}`}
        hint="Where the key light comes FROM (relative to the subject)."
      >
        <div className="flex flex-col gap-1.5">
          <div className="grid grid-cols-3 gap-1.5">
            {PAD.map((dir, i) =>
              dir ? (
                <button
                  key={dir}
                  type="button"
                  onClick={() => setDirection(dir)}
                  disabled={job.busy}
                  aria-pressed={direction === dir}
                  title={DIRECTION_LABEL[dir]}
                  className={`flex aspect-square flex-col items-center justify-center rounded-md border text-base leading-none transition-colors disabled:cursor-not-allowed disabled:opacity-60 ${
                    direction === dir
                      ? "border-accent bg-accent text-white"
                      : "border-edge bg-panelraised text-muted hover:text-ink"
                  }`}
                >
                  <span aria-hidden>{DIRECTION_GLYPH[dir]}</span>
                  <span className="mt-0.5 text-[9px] uppercase tracking-wide">
                    {DIRECTION_LABEL[dir]}
                  </span>
                </button>
              ) : (
                <span key={`spacer-${i}`} aria-hidden />
              ),
            )}
          </div>
          {/* "behind" (backlight) sits below the compass pad. */}
          <button
            type="button"
            onClick={() => setDirection("behind")}
            disabled={job.busy}
            aria-pressed={direction === "behind"}
            className={`flex items-center justify-center gap-1.5 rounded-md border py-1.5 text-[11px] font-semibold uppercase tracking-wide transition-colors disabled:cursor-not-allowed disabled:opacity-60 ${
              direction === "behind"
                ? "border-accent bg-accent text-white"
                : "border-edge bg-panelraised text-muted hover:text-ink"
            }`}
          >
            <span aria-hidden>{DIRECTION_GLYPH.behind}</span>
            {DIRECTION_LABEL.behind} (backlight)
          </button>
        </div>
      </Field>

      {/* Key-light color */}
      <Field
        label="Light color"
        hint="Drives the color temperature of the relight. Default is a warm white."
      >
        <div className="flex items-center gap-2.5">
          <input
            type="color"
            value={color}
            onChange={(e) => setColor(e.target.value)}
            disabled={job.busy}
            aria-label="Key-light color"
            className="h-8 w-10 flex-none cursor-pointer rounded border border-edge bg-panelraised disabled:cursor-not-allowed disabled:opacity-60"
          />
          <span className="text-[11px] tabular-nums text-muted">
            {color.toUpperCase()}
          </span>
          {color.toLowerCase() !== DEFAULT_LIGHT_COLOR && (
            <button
              type="button"
              className="btn ml-auto px-2 py-1 text-[11px]"
              onClick={() => setColor(DEFAULT_LIGHT_COLOR)}
              disabled={job.busy}
            >
              Reset
            </button>
          )}
        </div>
      </Field>

      {/* Intensity */}
      <Field
        label={`Intensity · ${Math.round(intensity * 100)}%`}
        hint="0% ≈ a whisper of directional shaping. 100% ≈ dramatic, high-contrast light."
      >
        <input
          type="range"
          min={0}
          max={1}
          step={0.05}
          value={intensity}
          onChange={(e) => setIntensity(Number(e.target.value))}
          disabled={job.busy}
          className="accent-accent"
          aria-label="Intensity"
        />
      </Field>

      {/* Optional scene to relight into */}
      <Field
        label="Relight into scene (optional)"
        hint="Describe a lighting environment to relight into — identity and composition are preserved."
      >
        <textarea
          value={backgroundPrompt}
          onChange={(e) => setBackgroundPrompt(e.target.value)}
          rows={2}
          placeholder="golden hour on a beach / moody neon-lit alley at night"
          className="resize-none rounded-md border border-edge bg-panelraised px-2.5 py-2 text-sm outline-none placeholder:text-muted/60 focus:border-accent"
        />
      </Field>

      {!hasContent && (
        <p className="text-xs text-amber-400">Add or generate an image first.</p>
      )}
      {hasContent && activeId && activeKind !== "raster" && (
        <p className="text-[11px] text-muted/80">
          Active layer isn’t a pixel layer — relighting the whole composite.
        </p>
      )}

      <button
        className="btn btn-accent justify-center py-2"
        onClick={onRun}
        disabled={!canRun}
      >
        {job.busy ? "Relighting…" : "Relight"}
      </button>

      <JobStatus {...job} doneLabel="Relit layer added." />
    </div>
  );
}
