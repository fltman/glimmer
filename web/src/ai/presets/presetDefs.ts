/**
 * SMART PRESETS — curated, one-click cinematic "looks".
 *
 * Each preset is an ordered list of AGENT_OPS steps reusing the SAME op
 * vocabulary the #12 agentic executor implements (`web/src/ai/agent/executor.ts`):
 *   - `add_adjustment` → a NON-DESTRUCTIVE adjustment layer (curves, color
 *     balance, hue/saturation, photo filter, black & white, gradient map, …).
 *   - `apply_filter`   → a destructive pixel filter on the active raster layer
 *     (vignette, add_noise, clarity, sharpen, …).
 *
 * A preset is therefore just a hand-authored `AgentPlan` — running it through
 * `executePlan(plan, buildExecutorHelpers(), onProgress)` applies every step as
 * a real engine edit. Because the bulk of each look is adjustment LAYERS, the
 * result is non-destructive and fully undoable (each `add_adjustment` is its own
 * layer; the one-or-two destructive grain/contrast filters are single undo
 * steps on the active layer). No AI job runs — presets are instant, local ops
 * and never touch the network, so provider keys are irrelevant here.
 *
 * PARAM SHAPES — every `params` object below uses the EXACT keys/ranges from the
 * engine registries:
 *   - adjustments: `web/src/engine/adjustments.ts` ADJUSTMENTS[type].paramsSchema
 *   - filters:     `web/src/engine/filters.ts`     FILTERS[type].paramsSchema
 * Missing keys fall back to each shader's per-key defaults (the `setUniforms`
 * `num(p.x, default)` / `colorFromParams(...)` pattern), so partial objects are
 * safe — but we generally spell out the keys that define the look.
 *
 * Note on ORDER: adjustment layers stack, so the LAST `add_adjustment` sits on
 * top. Destructive filters (`apply_filter`) hit the active RASTER layer, which
 * the executor resolves to the top raster layer when adjustment layers are
 * active — so grain/clarity land on the image pixels regardless of stacking.
 * We therefore put pixel filters (grain, clarity, vignette) at the END of a
 * recipe, after the color grade, which reads most like a real film pipeline.
 */
import type { AgentStep, AgentPlan } from "@aips/shared-types";
import type { AdjustmentType } from "../../engine/adjustments";
import type { FilterType } from "../../engine/filters";

// ──────────────────────────────────────────────────────────────
// Authoring helpers — typed thin wrappers so a recipe reads declaratively and
// the `type` strings are checked against the real engine unions at compile time.
// ──────────────────────────────────────────────────────────────

/** A non-destructive adjustment-layer step. `params` keys mirror ADJUSTMENTS. */
function adj(type: AdjustmentType, params: Record<string, unknown> = {}): AgentStep {
  return { op: "add_adjustment", params: { type, params } };
}

/** A destructive filter step on the active raster layer. `params` mirror FILTERS. */
function filt(type: FilterType, params: Record<string, unknown> = {}): AgentStep {
  return { op: "apply_filter", params: { type, params } };
}

// ──────────────────────────────────────────────────────────────
// Preset model
// ──────────────────────────────────────────────────────────────

/** A named look the user can apply with one click. */
export interface PresetDef {
  /** Stable id (used as a React key + idempotency hint). */
  id: string;
  /** Display name on the card. */
  name: string;
  /** One-line description of the mood. */
  description: string;
  /**
   * Two CSS colors that paint the card's gradient swatch so the grid reads as a
   * palette at a glance. Purely cosmetic (the look itself comes from `steps`).
   */
  swatch: [string, string];
  /** The ordered recipe. Each entry becomes one executed plan step. */
  steps: AgentStep[];
}

// ──────────────────────────────────────────────────────────────
// The looks (~10). Each is a small, opinionated grade. Values are deliberately
// moderate so a preset is a believable starting point, not a sledgehammer.
// ──────────────────────────────────────────────────────────────

export const PRESETS: readonly PresetDef[] = [
  {
    id: "teal_orange",
    name: "Cinematic Teal & Orange",
    description: "Hollywood blockbuster split-tone: warm skin, teal shadows.",
    swatch: ["#0e4d5c", "#e8954b"],
    steps: [
      // Gentle S-curve for filmic contrast (lift toe, roll shoulder).
      adj("curves", {
        rgb: [
          { x: 0, y: 0.02 },
          { x: 0.25, y: 0.2 },
          { x: 0.75, y: 0.82 },
          { x: 1, y: 0.98 },
        ],
      }),
      // Push shadows toward teal, highlights toward warm orange.
      adj("color_balance", {
        shadows: [-0.18, 0.02, 0.24],
        midtones: [0.04, 0.0, -0.04],
        highlights: [0.2, 0.06, -0.22],
        preserveLuminosity: true,
      }),
      // A touch more pop without over-saturating skin.
      adj("vibrance", { vibrance: 0.22, saturation: 0.05 }),
      // Local-contrast bite, the way a graded still feels crisp.
      filt("clarity", { amount: 0.25 }),
    ],
  },

  {
    id: "vintage_film",
    name: "Vintage Film",
    description: "Faded 70s stock: lifted blacks, warm cast, fine grain.",
    swatch: ["#6b5b3e", "#d8c9a3"],
    steps: [
      // Lift the blacks and pull the whites down for that washed, low-contrast base.
      adj("levels", { inBlack: 0, inWhite: 1, gamma: 1.05, outBlack: 0.08, outWhite: 0.94 }),
      // Warm amber photo filter.
      adj("photo_filter", {
        color: { r: 0.85, g: 0.55, b: 0.22, a: 1 },
        density: 0.3,
        preserveLuminosity: true,
      }),
      // Desaturate slightly — aged dyes.
      adj("hue_saturation", { hue: 0, saturation: -0.18, lightness: 0.02 }),
      // Per-channel curve: warm highlights, cool-ish shadows for cross-aged dye.
      adj("curves", {
        r: [
          { x: 0, y: 0.06 },
          { x: 1, y: 0.96 },
        ],
        b: [
          { x: 0, y: 0.04 },
          { x: 1, y: 0.9 },
        ],
      }),
      // Fine monochrome grain.
      filt("add_noise", { amount: 0.07, monochrome: true }),
    ],
  },

  {
    id: "bw_noir",
    name: "B&W Noir",
    description: "High-contrast black & white with deep shadows and grain.",
    swatch: ["#0a0a0a", "#e6e6e6"],
    steps: [
      // Channel-weighted desaturation: bright skies darken, skin stays luminous.
      adj("black_white", {
        red: 0.6,
        yellow: 0.85,
        green: 0.4,
        cyan: 0.3,
        blue: 0.15,
        magenta: 0.7,
      }),
      // Hard S-curve — crushed blacks, bright speculars.
      adj("curves", {
        rgb: [
          { x: 0, y: 0 },
          { x: 0.22, y: 0.1 },
          { x: 0.78, y: 0.92 },
          { x: 1, y: 1 },
        ],
      }),
      // Heavy vignette to pull the eye in.
      filt("vignette", { amount: 0.55, midpoint: 0.4, roundness: 0.4, feather: 0.5 }),
      // Coarse film grain.
      filt("add_noise", { amount: 0.1, monochrome: true }),
    ],
  },

  {
    id: "hdr_pop",
    name: "HDR Pop",
    description: "Punchy detail and saturation — clarity-driven, modern look.",
    swatch: ["#1a6fb0", "#f2c94c"],
    steps: [
      // Strong local-contrast (clarity) for the HDR "crunch".
      filt("clarity", { amount: 0.7 }),
      // Extra edge definition.
      filt("sharpen", { amount: 0.6 }),
      // Open up shadows, hold highlights (inverse-ish S that lifts midtones).
      adj("curves", {
        rgb: [
          { x: 0, y: 0.04 },
          { x: 0.35, y: 0.42 },
          { x: 0.7, y: 0.74 },
          { x: 1, y: 0.99 },
        ],
      }),
      // Saturated but protected by vibrance.
      adj("vibrance", { vibrance: 0.4, saturation: 0.12 }),
    ],
  },

  {
    id: "golden_hour",
    name: "Golden Hour",
    description: "Warm, glowing sunset light with soft, lifted shadows.",
    swatch: ["#c8722a", "#ffe2a8"],
    steps: [
      // Dense warm filter for that low-sun glow.
      adj("photo_filter", {
        color: { r: 0.98, g: 0.66, b: 0.25, a: 1 },
        density: 0.35,
        preserveLuminosity: true,
      }),
      // Warm the highlights, keep shadows neutral-warm.
      adj("color_balance", {
        shadows: [0.05, 0.0, -0.04],
        midtones: [0.08, 0.02, -0.08],
        highlights: [0.16, 0.06, -0.16],
        preserveLuminosity: true,
      }),
      // Lift the shadows for a soft, hazy base.
      adj("levels", { inBlack: 0, inWhite: 1, gamma: 1.08, outBlack: 0.06, outWhite: 1 }),
      // Gentle vibrance to make the warm tones sing.
      adj("vibrance", { vibrance: 0.2, saturation: 0.04 }),
    ],
  },

  {
    id: "cyberpunk",
    name: "Cool Cyberpunk",
    description: "Neon night city: magenta highlights, electric-blue shadows.",
    swatch: ["#1b1040", "#ff2e9a"],
    steps: [
      // Cool the whole frame down first.
      adj("color_balance", {
        shadows: [-0.1, -0.06, 0.3],
        midtones: [0.06, -0.08, 0.12],
        highlights: [0.24, -0.05, 0.1],
        preserveLuminosity: true,
      }),
      // Magenta/blue split via per-channel curves (lift blue shadows, magenta highs).
      adj("curves", {
        r: [
          { x: 0, y: 0 },
          { x: 0.7, y: 0.78 },
          { x: 1, y: 1 },
        ],
        b: [
          { x: 0, y: 0.12 },
          { x: 0.5, y: 0.58 },
          { x: 1, y: 1 },
        ],
      }),
      // Crank saturation for neon.
      adj("hue_saturation", { hue: 0, saturation: 0.3, lightness: -0.02 }),
      // Lens fringing sells the "shot at night on glass" feel.
      filt("chromatic_aberration", { amount: 4, edgeOnly: true }),
      // Dark, round vignette.
      filt("vignette", { amount: 0.4, midpoint: 0.45, roundness: 0.6, feather: 0.6 }),
    ],
  },

  {
    id: "matte_fade",
    name: "Matte Fade",
    description: "Modern Instagram matte: flattened blacks, muted color.",
    swatch: ["#4a4f57", "#cdbfb2"],
    steps: [
      // The signature matte move: raise output black so shadows never hit pure black.
      adj("levels", { inBlack: 0, inWhite: 0.96, gamma: 1.0, outBlack: 0.12, outWhite: 0.95 }),
      // Soft S-curve but keeping the lifted floor.
      adj("curves", {
        rgb: [
          { x: 0, y: 0.12 },
          { x: 0.5, y: 0.5 },
          { x: 1, y: 0.94 },
        ],
      }),
      // Pull saturation back for the muted, editorial feel.
      adj("vibrance", { vibrance: -0.12, saturation: -0.16 }),
      // A faint cool tint in the shadows.
      adj("color_balance", {
        shadows: [-0.04, 0.0, 0.08],
        midtones: [0, 0, 0],
        highlights: [0.04, 0.02, -0.04],
        preserveLuminosity: true,
      }),
    ],
  },

  {
    id: "bleach_bypass",
    name: "Bleach Bypass",
    description: "Desaturated, high-contrast silver-retention war-film look.",
    swatch: ["#2b2b2b", "#bfc4c0"],
    steps: [
      // Heavily reduce color — bleach bypass leaves a silvery, near-mono image.
      adj("hue_saturation", { hue: 0, saturation: -0.55, lightness: 0 }),
      // Aggressive contrast curve.
      adj("curves", {
        rgb: [
          { x: 0, y: 0 },
          { x: 0.25, y: 0.14 },
          { x: 0.75, y: 0.9 },
          { x: 1, y: 1 },
        ],
      }),
      // Slight green-steel cast in the midtones.
      adj("color_balance", {
        shadows: [-0.04, 0.04, 0.0],
        midtones: [0.0, 0.06, -0.02],
        highlights: [0.02, 0.04, -0.04],
        preserveLuminosity: true,
      }),
      // Local-contrast grit + fine grain.
      filt("clarity", { amount: 0.45 }),
      filt("add_noise", { amount: 0.05, monochrome: true }),
    ],
  },

  {
    id: "cross_process",
    name: "Cross Process",
    description: "C-41-in-E6 colour shift: green shadows, yellow highlights.",
    swatch: ["#3c5a2e", "#e8d24a"],
    steps: [
      // The classic cross-process channel twist (skewed per-channel curves).
      adj("curves", {
        r: [
          { x: 0, y: 0 },
          { x: 0.5, y: 0.58 },
          { x: 1, y: 0.95 },
        ],
        g: [
          { x: 0, y: 0.06 },
          { x: 0.5, y: 0.5 },
          { x: 1, y: 1 },
        ],
        b: [
          { x: 0, y: 0.14 },
          { x: 0.5, y: 0.42 },
          { x: 1, y: 0.85 },
        ],
      }),
      // Green/yellow shadow bias, cyan-ish highlights.
      adj("color_balance", {
        shadows: [-0.12, 0.16, -0.06],
        midtones: [0.04, 0.06, -0.1],
        highlights: [0.06, 0.04, -0.18],
        preserveLuminosity: false,
      }),
      // Boost saturation — cross-process is loud.
      adj("hue_saturation", { hue: 0, saturation: 0.28, lightness: 0 }),
    ],
  },

  {
    id: "dreamy_soft",
    name: "Dreamy Soft",
    description: "Hazy pastel glow — soft contrast, airy highlights, fine bloom.",
    swatch: ["#d8a7c4", "#fbe9d0"],
    steps: [
      // Airy, low-contrast base with lifted shadows.
      adj("levels", { inBlack: 0, inWhite: 1, gamma: 1.12, outBlack: 0.1, outWhite: 1 }),
      // Pull saturation back to pastel.
      adj("vibrance", { vibrance: -0.06, saturation: -0.1 }),
      // Soft warm-pink wash.
      adj("photo_filter", {
        color: { r: 0.95, g: 0.7, b: 0.78, a: 1 },
        density: 0.18,
        preserveLuminosity: true,
      }),
      // Gradient map (deep plum → warm cream) at gentle layer strength reads as a
      // tone-mapped glow. Applied last so it sits on top of the grade.
      adj("gradient_map", {
        stops: [
          { pos: 0, color: { r: 0.22, g: 0.12, b: 0.26, a: 1 } },
          { pos: 0.5, color: { r: 0.78, g: 0.6, b: 0.62, a: 1 } },
          { pos: 1, color: { r: 0.99, g: 0.94, b: 0.86, a: 1 } },
        ],
      }),
      // A whisper of bloom to soften speculars.
      filt("lens_blur", { radius: 3, brightnessBoost: 0.6 }),
    ],
  },
] as const;

// ──────────────────────────────────────────────────────────────
// Plan construction
// ──────────────────────────────────────────────────────────────

/**
 * Build an executable AgentPlan from a preset def. Each step's `rationale` is a
 * tiny human note ("Color Balance · split-tone") so the running checklist reads
 * nicely — purely cosmetic; the executor ignores `rationale`.
 */
export function presetToPlan(preset: PresetDef): AgentPlan {
  return {
    steps: preset.steps.map((s) => ({
      ...s,
      rationale: stepNote(s),
    })),
    message: `Applying “${preset.name}”…`,
  };
}

/** Title-case an enum/op token: "color_balance" → "Color Balance". */
export function humanizeToken(token: string): string {
  return token
    .split(/[_\s]+/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

/** A compact, present-tense note for one preset step (drives the per-step line). */
export function stepNote(step: AgentStep): string {
  const p = (step.params ?? {}) as Record<string, unknown>;
  const type = typeof p.type === "string" ? p.type : "";
  if (step.op === "add_adjustment") return `${humanizeToken(type)} adjustment`;
  if (step.op === "apply_filter") return `${humanizeToken(type)} filter`;
  return humanizeToken(step.op);
}
