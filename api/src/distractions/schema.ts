/**
 * Zod schemas for the distraction-analysis endpoint (POST /ai/analyze-distractions).
 *
 * Two distinct schemas live here:
 *  - `AnalyzeDistractionsRequestSchema` gates the inbound HTTP body.
 *  - `RawDistractionsSchema` + `coerceDistractions` validate/sanitize the JSON
 *    the vision model returns. Malformed entries are DROPPED (not rejected) so a
 *    single bad region doesn't sink an otherwise-usable list — and boxes are
 *    clamped to [0,1] normalized image coordinates.
 *
 * The wire shape is the source of truth in @aips/shared-types
 * (DistractionRegion / AnalyzeDistractionsResponse).
 */
import { z } from "zod";
import { AssetRefSchema } from "../jobs/schema.js";
import type { DistractionRegion, DistractionSeverity } from "@aips/shared-types";

/** Inbound request body for POST /ai/analyze-distractions. */
export const AnalyzeDistractionsRequestSchema = z.object({
  image: AssetRefSchema,
});

export type AnalyzeDistractionsRequestBody = z.infer<
  typeof AnalyzeDistractionsRequestSchema
>;

const SEVERITIES = ["low", "medium", "high"] as const;

/**
 * A single region as emitted by the model. Tolerant-by-design: the model is an
 * LLM, so a malformed field on one region must NOT sink the whole list.
 *  - `id` / `label` fall back to "" when not a clean string (filtered later).
 *  - `severity` falls back to "medium" when it isn't a known value.
 *  - `box` coords coerce to numbers; non-numeric → null so coerce can drop them.
 */
const NumberLike = z
  .union([z.number(), z.string()])
  .transform((v) => (typeof v === "string" ? Number(v) : v))
  .pipe(z.number())
  .catch(NaN);

const RawBoxSchema = z
  .object({
    x: NumberLike,
    y: NumberLike,
    width: NumberLike,
    height: NumberLike,
  })
  .catch({ x: NaN, y: NaN, width: NaN, height: NaN });

const RawRegionSchema = z
  .object({
    id: z.string().catch(""),
    label: z.string().catch(""),
    rationale: z.string().max(2000).optional().catch(undefined),
    severity: z
      .enum(SEVERITIES)
      .catch("medium" as DistractionSeverity),
    box: RawBoxSchema,
  })
  .catch({
    id: "",
    label: "",
    rationale: undefined,
    severity: "medium",
    box: { x: NaN, y: NaN, width: NaN, height: NaN },
  });

/** The raw response shape we expect the model to return as JSON. */
export const RawDistractionsSchema = z.object({
  // Tolerate a missing/garbled `distractions` (→ []) so a "nothing found"
  // response (or a slightly malformed one) still parses cleanly.
  distractions: z.array(RawRegionSchema).catch([]).default([]),
  message: z.string().max(4000).optional().catch(undefined),
});

export type RawDistractions = z.infer<typeof RawDistractionsSchema>;

const clamp01 = (n: number): number => (n < 0 ? 0 : n > 1 ? 1 : n);

/**
 * Validate + sanitize the model's raw output into wire-safe DistractionRegions:
 *  - drops regions with no usable label or a non-finite box,
 *  - clamps box x/y/width/height into [0,1] (normalized image coords) and
 *    shrinks width/height so the box never extends past the image edge,
 *  - drops zero-area boxes,
 *  - assigns a stable id when the model omitted one.
 *
 * Returns the cleaned list plus how many entries were dropped (for logs).
 */
export function coerceDistractions(raw: RawDistractions): {
  distractions: DistractionRegion[];
  dropped: number;
} {
  const out: DistractionRegion[] = [];
  let dropped = 0;

  raw.distractions.forEach((r, i) => {
    const label = r.label.trim();
    const { x, y, width, height } = r.box;
    const finite =
      Number.isFinite(x) &&
      Number.isFinite(y) &&
      Number.isFinite(width) &&
      Number.isFinite(height);
    if (label.length === 0 || !finite) {
      dropped += 1;
      return;
    }

    const cx = clamp01(x);
    const cy = clamp01(y);
    // Clamp size, then shrink so the box stays inside the image bounds.
    const cw = Math.min(clamp01(width), 1 - cx);
    const ch = Math.min(clamp01(height), 1 - cy);
    if (cw <= 0 || ch <= 0) {
      dropped += 1;
      return;
    }

    out.push({
      id: r.id.trim() || `d${i + 1}`,
      label,
      ...(r.rationale && r.rationale.trim() ? { rationale: r.rationale.trim() } : {}),
      severity: r.severity,
      box: { x: cx, y: cy, width: cw, height: ch },
    });
  });

  return { distractions: out, dropped };
}
