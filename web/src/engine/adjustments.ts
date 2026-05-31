/**
 * Non-destructive adjustment registry.
 *
 * Each adjustment is a GPU pass that reads the current backdrop (everything
 * composited BELOW the adjustment layer, premultiplied linear) and writes the
 * adjusted result. The engine runs them as fullscreen passes inside the
 * ping-pong fold (see EditorEngine.render), so they modify the composite in
 * place and respect the adjustment layer's opacity, mask, and clipping.
 *
 * Color-space discipline:
 *  - The backdrop accumulator is PREMULTIPLIED LINEAR. The uber-adjustment
 *    shader un-premultiplies to straight linear, then (for adjustments that are
 *    conventionally defined in display/sRGB space — levels, curves, posterize,
 *    threshold, gradient_map, black_white luma, hue/sat) converts to sRGB,
 *    applies the operation, and converts back to linear. Adjustments that are
 *    physically meaningful in linear light (exposure) stay in linear.
 *  - LUT-based adjustments (levels, curves, gradient_map) build a 256x1 RGBA
 *    LUT on the CPU and sample it in-shader (sRGB domain), so the curve shape is
 *    WYSIWYG with Photoshop.
 *
 * The registry is data-driven so the UI can render a parameter panel per
 * adjustment from `paramsSchema` without hard-coding any types.
 */

/** Discriminated set of supported adjustment types (stable string keys). */
export type AdjustmentType =
  | "brightness_contrast"
  | "levels"
  | "curves"
  | "exposure"
  | "hue_saturation"
  | "vibrance"
  | "color_balance"
  | "black_white"
  | "photo_filter"
  | "channel_mixer"
  | "invert"
  | "posterize"
  | "threshold"
  | "gradient_map";

/** Loose parameter bag; each adjustment documents its own keys below. */
export type AdjustmentParams = Record<string, unknown>;

/** A control point on a curve (input/output both 0..1). */
export interface CurvePoint {
  x: number;
  y: number;
}

/** A gradient stop in sRGB straight (0..1) for gradient_map / gradient fill. */
export interface GradientStop {
  /** Position along the gradient 0..1. */
  pos: number;
  /** sRGB straight color 0..1. */
  color: { r: number; g: number; b: number; a: number };
}

/** One field in a data-driven parameter panel. */
export type ParamField =
  | {
      kind: "slider";
      key: string;
      label: string;
      min: number;
      max: number;
      step: number;
      default: number;
    }
  | {
      kind: "checkbox";
      key: string;
      label: string;
      default: boolean;
    }
  | {
      kind: "select";
      key: string;
      label: string;
      options: { value: string; label: string }[];
      default: string;
    }
  | {
      kind: "color";
      key: string;
      label: string;
      /** sRGB straight default. */
      default: { r: number; g: number; b: number; a: number };
    }
  | {
      kind: "curve";
      key: string;
      label: string;
      /** Which channel the curve edits ("rgb"|"r"|"g"|"b") — purely advisory. */
      channel?: "rgb" | "r" | "g" | "b";
      default: CurvePoint[];
    }
  | {
      kind: "gradient";
      key: string;
      label: string;
      default: GradientStop[];
    };

/**
 * Adjustment definition. The engine compiles `fragSource` once and calls
 * `setUniforms` to push the params for each draw. LUT-backed adjustments set
 * `needsLUT: true` and provide `buildLUT(params) -> Uint8Array(256*4)`; the
 * engine uploads that as a 256x1 RGBA texture bound to `u_lut` (sampler unit
 * given to `setUniforms` as `lutUnit`).
 */
export interface AdjustmentDef {
  type: AdjustmentType;
  label: string;
  /** Default parameter object (deep-cloned on insert). */
  defaults: AdjustmentParams;
  /** Data-driven panel description for the UI. */
  paramsSchema: ParamField[];
  /** Fragment shader source (uber-adjustment body). */
  fragSource: string;
  /** True when the adjustment samples a 256x1 RGBA LUT. */
  needsLUT?: boolean;
  /** Build the 256*4-byte sRGB-domain LUT from params (one row, RGBA per i). */
  buildLUT?: (params: AdjustmentParams) => Uint8Array;
  /**
   * Push per-draw uniforms. `loc(name)` resolves a uniform location for the
   * adjustment's compiled program; `gl` is the live context. The engine has
   * already bound the backdrop to `u_backdrop` (unit 0) and (when needsLUT) the
   * LUT to `u_lut` and set `u_lut`'s sampler int. Adjustments only need to push
   * their own scalar/vector params here.
   */
  setUniforms?: (
    gl: WebGL2RenderingContext,
    loc: (name: string) => WebGLUniformLocation | null,
    params: AdjustmentParams,
  ) => void;
}

// ── shared GLSL preamble ──────────────────────────────────
// Every adjustment shader shares this header. It declares the standard
// uniforms the engine always sets (backdrop, viewport, opacity, mask,
// clipping) and provides helpers + the source-over recompositing tail so each
// adjustment body only has to implement `vec3 adjust(vec3 c)` (straight color
// in the documented working space).
const ADJ_HEADER = /* glsl */ `#version 300 es
precision highp float;
in vec2 v_uv;
out vec4 fragColor;

uniform sampler2D u_backdrop;   // premultiplied LINEAR composite below this layer
uniform vec2  u_backdropSize;   // px
uniform float u_amount;         // adjustment layer opacity 0..1 (effect mix)
uniform bool  u_useMask;        // modulate amount by a layer mask
uniform sampler2D u_mask;       // R8 layer mask (full-doc resolution)
uniform mat3  u_uvToMask;       // viewport uv -> mask uv
uniform bool  u_useClip;        // clip the effect to the layer below's alpha
uniform sampler2D u_clip;       // straight-alpha texture of the layer below
uniform mat3  u_uvToClip;       // viewport uv -> clip-layer uv

vec3 srgbToLinear(vec3 c) {
  return mix(c / 12.92, pow((c + 0.055) / 1.055, vec3(2.4)), step(0.04045, c));
}
vec3 linearToSrgb(vec3 c) {
  return mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(0.0031308, c));
}
float luma709(vec3 c) { return dot(c, vec3(0.2126, 0.7152, 0.0722)); }
`;

// The recomposite tail: sample backdrop (premul linear), un-premultiply, run
// `adjust()` (subclass-defined), then mix by effective amount and re-premultiply.
const ADJ_MAIN = /* glsl */ `
void main() {
  vec4 bp = texture(u_backdrop, v_uv);
  float a = bp.a;
  vec3 cl = a > 1e-5 ? bp.rgb / a : vec3(0.0); // straight linear

  float amt = u_amount;
  if (u_useMask) {
    vec3 mUv = u_uvToMask * vec3(v_uv, 1.0);
    amt *= texture(u_mask, mUv.xy).r;
  }
  if (u_useClip) {
    vec3 cUv = u_uvToClip * vec3(v_uv, 1.0);
    amt *= texture(u_clip, cUv.xy).a;
  }

  vec3 adjusted = adjust(cl);          // straight linear out
  vec3 outCol = mix(cl, adjusted, amt); // blend by effective amount
  fragColor = vec4(outCol * a, a);      // re-premultiply, preserve backdrop alpha
}
`;

/** Compose a full shader from an `adjust()` body. */
function makeShader(body: string): string {
  return ADJ_HEADER + body + ADJ_MAIN;
}

/** sRGB-domain wrapper: convert linear -> sRGB, run f(), convert back. */
function srgbBody(inner: string): string {
  return /* glsl */ `
vec3 adjust(vec3 linC) {
  vec3 c = clamp(linearToSrgb(linC), 0.0, 1.0);
  ${inner}
  return srgbToLinear(clamp(c, 0.0, 1.0));
}
`;
}

// ── LUT helpers (CPU) ─────────────────────────────────────
function srgbToLin(c: number): number {
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}
function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

/** Evaluate a monotone-x control-point curve at t (0..1) with linear segments. */
function evalCurve(points: CurvePoint[], t: number): number {
  if (points.length === 0) return t;
  const pts = [...points].sort((p, q) => p.x - q.x);
  if (t <= pts[0]!.x) return clamp01(pts[0]!.y);
  if (t >= pts[pts.length - 1]!.x) return clamp01(pts[pts.length - 1]!.y);
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i]!;
    const b = pts[i + 1]!;
    if (t >= a.x && t <= b.x) {
      const span = b.x - a.x;
      const f = span > 1e-6 ? (t - a.x) / span : 0;
      return clamp01(a.y + (b.y - a.y) * f);
    }
  }
  return t;
}

// ───────────────────────────── REGISTRY ───────────────────
export const ADJUSTMENTS: Record<AdjustmentType, AdjustmentDef> = {
  // Brightness/Contrast — applied in sRGB display space (matches PS legacy=off
  // pivot-at-mid). brightness in [-1,1], contrast in [-1,1].
  brightness_contrast: {
    type: "brightness_contrast",
    label: "Brightness/Contrast",
    defaults: { brightness: 0, contrast: 0 },
    paramsSchema: [
      { kind: "slider", key: "brightness", label: "Brightness", min: -1, max: 1, step: 0.01, default: 0 },
      { kind: "slider", key: "contrast", label: "Contrast", min: -1, max: 1, step: 0.01, default: 0 },
    ],
    fragSource: makeShader(
      /* glsl */ `
uniform float u_brightness;
uniform float u_contrast;
` +
        srgbBody(/* glsl */ `
  c += u_brightness;
  float k = tan((clamp(u_contrast, -0.999, 0.999) + 1.0) * 0.7853981634); // [-1,1] -> slope
  c = (c - 0.5) * k + 0.5;
`),
    ),
    setUniforms: (gl, loc, p) => {
      gl.uniform1f(loc("u_brightness"), num(p.brightness));
      gl.uniform1f(loc("u_contrast"), num(p.contrast));
    },
  },

  // Levels — per-channel + composite input/output black/white/gamma, baked to
  // a LUT in sRGB domain.
  levels: {
    type: "levels",
    label: "Levels",
    defaults: {
      inBlack: 0,
      inWhite: 1,
      gamma: 1,
      outBlack: 0,
      outWhite: 1,
    },
    paramsSchema: [
      { kind: "slider", key: "inBlack", label: "Input Black", min: 0, max: 1, step: 0.004, default: 0 },
      { kind: "slider", key: "inWhite", label: "Input White", min: 0, max: 1, step: 0.004, default: 1 },
      { kind: "slider", key: "gamma", label: "Gamma", min: 0.1, max: 9.99, step: 0.01, default: 1 },
      { kind: "slider", key: "outBlack", label: "Output Black", min: 0, max: 1, step: 0.004, default: 0 },
      { kind: "slider", key: "outWhite", label: "Output White", min: 0, max: 1, step: 0.004, default: 1 },
    ],
    needsLUT: true,
    buildLUT: (p) => {
      const inB = num(p.inBlack);
      const inW = num(p.inWhite, 1);
      const g = Math.max(0.01, num(p.gamma, 1));
      const outB = num(p.outBlack);
      const outW = num(p.outWhite, 1);
      const lut = new Uint8Array(256 * 4);
      const span = Math.max(1e-4, inW - inB);
      for (let i = 0; i < 256; i++) {
        const t = i / 255;
        let v = clamp01((t - inB) / span);
        v = Math.pow(v, 1 / g);
        v = outB + v * (outW - outB);
        const b = Math.round(clamp01(v) * 255);
        lut[i * 4] = b;
        lut[i * 4 + 1] = b;
        lut[i * 4 + 2] = b;
        lut[i * 4 + 3] = 255;
      }
      return lut;
    },
    fragSource: makeShader(
      /* glsl */ `
uniform sampler2D u_lut;
` +
        srgbBody(/* glsl */ `
  c.r = texture(u_lut, vec2(c.r, 0.5)).r;
  c.g = texture(u_lut, vec2(c.g, 0.5)).g;
  c.b = texture(u_lut, vec2(c.b, 0.5)).b;
`),
    ),
  },

  // Curves — composite RGB curve from control points, baked to a LUT.
  curves: {
    type: "curves",
    label: "Curves",
    defaults: {
      rgb: [
        { x: 0, y: 0 },
        { x: 1, y: 1 },
      ],
      r: [
        { x: 0, y: 0 },
        { x: 1, y: 1 },
      ],
      g: [
        { x: 0, y: 0 },
        { x: 1, y: 1 },
      ],
      b: [
        { x: 0, y: 0 },
        { x: 1, y: 1 },
      ],
    },
    paramsSchema: [
      { kind: "curve", key: "rgb", label: "RGB", channel: "rgb", default: [{ x: 0, y: 0 }, { x: 1, y: 1 }] },
      { kind: "curve", key: "r", label: "Red", channel: "r", default: [{ x: 0, y: 0 }, { x: 1, y: 1 }] },
      { kind: "curve", key: "g", label: "Green", channel: "g", default: [{ x: 0, y: 0 }, { x: 1, y: 1 }] },
      { kind: "curve", key: "b", label: "Blue", channel: "b", default: [{ x: 0, y: 0 }, { x: 1, y: 1 }] },
    ],
    needsLUT: true,
    buildLUT: (p) => {
      const master = (p.rgb as CurvePoint[]) ?? [{ x: 0, y: 0 }, { x: 1, y: 1 }];
      const rc = (p.r as CurvePoint[]) ?? [{ x: 0, y: 0 }, { x: 1, y: 1 }];
      const gc = (p.g as CurvePoint[]) ?? [{ x: 0, y: 0 }, { x: 1, y: 1 }];
      const bc = (p.b as CurvePoint[]) ?? [{ x: 0, y: 0 }, { x: 1, y: 1 }];
      const lut = new Uint8Array(256 * 4);
      for (let i = 0; i < 256; i++) {
        const t = i / 255;
        // Per-channel curve, then the master (RGB) curve applied on top.
        const r = evalCurve(master, evalCurve(rc, t));
        const g = evalCurve(master, evalCurve(gc, t));
        const b = evalCurve(master, evalCurve(bc, t));
        lut[i * 4] = Math.round(r * 255);
        lut[i * 4 + 1] = Math.round(g * 255);
        lut[i * 4 + 2] = Math.round(b * 255);
        lut[i * 4 + 3] = 255;
      }
      return lut;
    },
    fragSource: makeShader(
      /* glsl */ `
uniform sampler2D u_lut;
` +
        srgbBody(/* glsl */ `
  c.r = texture(u_lut, vec2(c.r, 0.5)).r;
  c.g = texture(u_lut, vec2(c.g, 0.5)).g;
  c.b = texture(u_lut, vec2(c.b, 0.5)).b;
`),
    ),
  },

  // Exposure — physically a linear-light scale (stops) + offset, with output
  // gamma. exposure in stops, offset small, gamma correction.
  exposure: {
    type: "exposure",
    label: "Exposure",
    defaults: { exposure: 0, offset: 0, gamma: 1 },
    paramsSchema: [
      { kind: "slider", key: "exposure", label: "Exposure", min: -5, max: 5, step: 0.01, default: 0 },
      { kind: "slider", key: "offset", label: "Offset", min: -0.5, max: 0.5, step: 0.001, default: 0 },
      { kind: "slider", key: "gamma", label: "Gamma", min: 0.1, max: 3, step: 0.01, default: 1 },
    ],
    fragSource: makeShader(
      /* glsl */ `
uniform float u_exposure;
uniform float u_offset;
uniform float u_gammaE;
vec3 adjust(vec3 linC) {
  // Linear-light exposure: scale by 2^stops, add offset.
  vec3 c = linC * exp2(u_exposure) + u_offset;
  c = max(c, 0.0);
  // Photoshop's exposure gamma correction is applied in linear too.
  c = pow(c, vec3(1.0 / max(u_gammaE, 0.01)));
  return c;
}
`,
    ),
    setUniforms: (gl, loc, p) => {
      gl.uniform1f(loc("u_exposure"), num(p.exposure));
      gl.uniform1f(loc("u_offset"), num(p.offset));
      gl.uniform1f(loc("u_gammaE"), num(p.gamma, 1));
    },
  },

  // Hue/Saturation — hue rotate (degrees), saturation/lightness in [-1,1].
  // Operates in sRGB display space like Photoshop.
  hue_saturation: {
    type: "hue_saturation",
    label: "Hue/Saturation",
    defaults: { hue: 0, saturation: 0, lightness: 0 },
    paramsSchema: [
      { kind: "slider", key: "hue", label: "Hue", min: -180, max: 180, step: 1, default: 0 },
      { kind: "slider", key: "saturation", label: "Saturation", min: -1, max: 1, step: 0.01, default: 0 },
      { kind: "slider", key: "lightness", label: "Lightness", min: -1, max: 1, step: 0.01, default: 0 },
    ],
    fragSource: makeShader(
      /* glsl */ `
uniform float u_hue;        // radians
uniform float u_sat;        // -1..1
uniform float u_lightness;  // -1..1
vec3 rgb2hsl(vec3 c) {
  float mx = max(max(c.r, c.g), c.b);
  float mn = min(min(c.r, c.g), c.b);
  float l = (mx + mn) * 0.5;
  float h = 0.0, s = 0.0;
  float d = mx - mn;
  if (d > 1e-5) {
    s = l > 0.5 ? d / (2.0 - mx - mn) : d / (mx + mn);
    if (mx == c.r) h = (c.g - c.b) / d + (c.g < c.b ? 6.0 : 0.0);
    else if (mx == c.g) h = (c.b - c.r) / d + 2.0;
    else h = (c.r - c.g) / d + 4.0;
    h /= 6.0;
  }
  return vec3(h, s, l);
}
float hue2rgb(float p, float q, float t) {
  if (t < 0.0) t += 1.0;
  if (t > 1.0) t -= 1.0;
  if (t < 1.0/6.0) return p + (q - p) * 6.0 * t;
  if (t < 1.0/2.0) return q;
  if (t < 2.0/3.0) return p + (q - p) * (2.0/3.0 - t) * 6.0;
  return p;
}
vec3 hsl2rgb(vec3 hsl) {
  float h = hsl.x, s = hsl.y, l = hsl.z;
  if (s <= 0.0) return vec3(l);
  float q = l < 0.5 ? l * (1.0 + s) : l + s - l * s;
  float p = 2.0 * l - q;
  return vec3(hue2rgb(p, q, h + 1.0/3.0), hue2rgb(p, q, h), hue2rgb(p, q, h - 1.0/3.0));
}
` +
        srgbBody(/* glsl */ `
  vec3 hsl = rgb2hsl(c);
  hsl.x = fract(hsl.x + u_hue / 6.2831853);
  hsl.y = clamp(hsl.y * (1.0 + u_sat), 0.0, 1.0);
  hsl.z = clamp(hsl.z + u_lightness * (u_lightness > 0.0 ? (1.0 - hsl.z) : hsl.z), 0.0, 1.0);
  c = hsl2rgb(hsl);
`),
    ),
    setUniforms: (gl, loc, p) => {
      gl.uniform1f(loc("u_hue"), (num(p.hue) * Math.PI) / 180);
      gl.uniform1f(loc("u_sat"), num(p.saturation));
      gl.uniform1f(loc("u_lightness"), num(p.lightness));
    },
  },

  // Vibrance — non-linear saturation that protects already-saturated pixels and
  // skin tones. amount in [-1,1].
  vibrance: {
    type: "vibrance",
    label: "Vibrance",
    defaults: { vibrance: 0, saturation: 0 },
    paramsSchema: [
      { kind: "slider", key: "vibrance", label: "Vibrance", min: -1, max: 1, step: 0.01, default: 0 },
      { kind: "slider", key: "saturation", label: "Saturation", min: -1, max: 1, step: 0.01, default: 0 },
    ],
    fragSource: makeShader(
      /* glsl */ `
uniform float u_vib;
uniform float u_satV;
` +
        srgbBody(/* glsl */ `
  float mx = max(max(c.r, c.g), c.b);
  float mn = min(min(c.r, c.g), c.b);
  float sat = mx - mn;
  float lum = luma709(c);
  // Vibrance boosts low-sat pixels more. Photoshop-ish curve.
  float vibAmt = u_vib * (1.0 - sat);
  float satAmt = u_satV;
  float k = 1.0 + vibAmt + satAmt;
  c = mix(vec3(lum), c, k);
`),
    ),
    setUniforms: (gl, loc, p) => {
      gl.uniform1f(loc("u_vib"), num(p.vibrance));
      gl.uniform1f(loc("u_satV"), num(p.saturation));
    },
  },

  // Color Balance — additive shifts per tonal range (shadows/mids/highlights).
  // Each is a vec3 in [-1,1] (cyan-red, magenta-green, yellow-blue). sRGB.
  color_balance: {
    type: "color_balance",
    label: "Color Balance",
    defaults: {
      shadows: [0, 0, 0],
      midtones: [0, 0, 0],
      highlights: [0, 0, 0],
      preserveLuminosity: true,
    },
    paramsSchema: [
      { kind: "slider", key: "shadowsR", label: "Shadows Cyan-Red", min: -1, max: 1, step: 0.01, default: 0 },
      { kind: "slider", key: "shadowsG", label: "Shadows Magenta-Green", min: -1, max: 1, step: 0.01, default: 0 },
      { kind: "slider", key: "shadowsB", label: "Shadows Yellow-Blue", min: -1, max: 1, step: 0.01, default: 0 },
      { kind: "slider", key: "midtonesR", label: "Midtones Cyan-Red", min: -1, max: 1, step: 0.01, default: 0 },
      { kind: "slider", key: "midtonesG", label: "Midtones Magenta-Green", min: -1, max: 1, step: 0.01, default: 0 },
      { kind: "slider", key: "midtonesB", label: "Midtones Yellow-Blue", min: -1, max: 1, step: 0.01, default: 0 },
      { kind: "slider", key: "highlightsR", label: "Highlights Cyan-Red", min: -1, max: 1, step: 0.01, default: 0 },
      { kind: "slider", key: "highlightsG", label: "Highlights Magenta-Green", min: -1, max: 1, step: 0.01, default: 0 },
      { kind: "slider", key: "highlightsB", label: "Highlights Yellow-Blue", min: -1, max: 1, step: 0.01, default: 0 },
      { kind: "checkbox", key: "preserveLuminosity", label: "Preserve Luminosity", default: true },
    ],
    fragSource: makeShader(
      /* glsl */ `
uniform vec3 u_shadows;
uniform vec3 u_mids;
uniform vec3 u_highs;
uniform bool u_preserveLum;
` +
        srgbBody(/* glsl */ `
  float lumBefore = luma709(c);
  // Per-channel tonal-range weights (smooth, peak in their band).
  vec3 shadowW = 1.0 - smoothstep(0.0, 0.5, c);
  vec3 highW = smoothstep(0.5, 1.0, c);
  vec3 midW = 1.0 - shadowW - highW;
  c += u_shadows * 0.5 * shadowW;
  c += u_mids * 0.5 * midW;
  c += u_highs * 0.5 * highW;
  c = clamp(c, 0.0, 1.0);
  if (u_preserveLum) {
    float lumAfter = luma709(c);
    c += (lumBefore - lumAfter);
    c = clamp(c, 0.0, 1.0);
  }
`),
    ),
    setUniforms: (gl, loc, p) => {
      // Allow either grouped vec3 arrays or flat per-slider keys.
      const sh = vec3FromParams(p, "shadows", "shadowsR", "shadowsG", "shadowsB");
      const mi = vec3FromParams(p, "midtones", "midtonesR", "midtonesG", "midtonesB");
      const hi = vec3FromParams(p, "highlights", "highlightsR", "highlightsG", "highlightsB");
      gl.uniform3f(loc("u_shadows"), sh[0], sh[1], sh[2]);
      gl.uniform3f(loc("u_mids"), mi[0], mi[1], mi[2]);
      gl.uniform3f(loc("u_highs"), hi[0], hi[1], hi[2]);
      gl.uniform1i(loc("u_preserveLum"), bool(p.preserveLuminosity, true) ? 1 : 0);
    },
  },

  // Black & White — channel-weighted desaturation (6 color sliders), sRGB.
  black_white: {
    type: "black_white",
    label: "Black & White",
    defaults: { red: 0.4, yellow: 0.6, green: 0.4, cyan: 0.6, blue: 0.2, magenta: 0.8 },
    paramsSchema: [
      { kind: "slider", key: "red", label: "Reds", min: -2, max: 3, step: 0.01, default: 0.4 },
      { kind: "slider", key: "yellow", label: "Yellows", min: -2, max: 3, step: 0.01, default: 0.6 },
      { kind: "slider", key: "green", label: "Greens", min: -2, max: 3, step: 0.01, default: 0.4 },
      { kind: "slider", key: "cyan", label: "Cyans", min: -2, max: 3, step: 0.01, default: 0.6 },
      { kind: "slider", key: "blue", label: "Blues", min: -2, max: 3, step: 0.01, default: 0.2 },
      { kind: "slider", key: "magenta", label: "Magentas", min: -2, max: 3, step: 0.01, default: 0.8 },
    ],
    fragSource: makeShader(
      /* glsl */ `
uniform float u_wRed, u_wYellow, u_wGreen, u_wCyan, u_wBlue, u_wMagenta;
` +
        srgbBody(/* glsl */ `
  float mn = min(min(c.r, c.g), c.b);
  // Decompose into the 6 color components by dominant hue contribution.
  float r = c.r, g = c.g, b = c.b;
  float red = max(0.0, min(r - g, r - b));
  float green = max(0.0, min(g - r, g - b));
  float blue = max(0.0, min(b - r, b - g));
  float yellow = max(0.0, min(r, g) - b);
  float cyan = max(0.0, min(g, b) - r);
  float magenta = max(0.0, min(r, b) - g);
  float gray = mn
    + red * u_wRed + green * u_wGreen + blue * u_wBlue
    + yellow * u_wYellow + cyan * u_wCyan + magenta * u_wMagenta;
  gray = clamp(gray, 0.0, 1.0);
  c = vec3(gray);
`),
    ),
    setUniforms: (gl, loc, p) => {
      gl.uniform1f(loc("u_wRed"), num(p.red, 0.4));
      gl.uniform1f(loc("u_wYellow"), num(p.yellow, 0.6));
      gl.uniform1f(loc("u_wGreen"), num(p.green, 0.4));
      gl.uniform1f(loc("u_wCyan"), num(p.cyan, 0.6));
      gl.uniform1f(loc("u_wBlue"), num(p.blue, 0.2));
      gl.uniform1f(loc("u_wMagenta"), num(p.magenta, 0.8));
    },
  },

  // Photo Filter — warm/cool tint at a given density, luminosity-preserving.
  photo_filter: {
    type: "photo_filter",
    label: "Photo Filter",
    defaults: { color: { r: 0.92, g: 0.6, b: 0.2, a: 1 }, density: 0.25, preserveLuminosity: true },
    paramsSchema: [
      { kind: "color", key: "color", label: "Filter Color", default: { r: 0.92, g: 0.6, b: 0.2, a: 1 } },
      { kind: "slider", key: "density", label: "Density", min: 0, max: 1, step: 0.01, default: 0.25 },
      { kind: "checkbox", key: "preserveLuminosity", label: "Preserve Luminosity", default: true },
    ],
    fragSource: makeShader(
      /* glsl */ `
uniform vec3 u_filter;       // filter color (sRGB)
uniform float u_density;     // 0..1
uniform bool u_preserveLumP;
` +
        srgbBody(/* glsl */ `
  float lumBefore = luma709(c);
  // Multiply-toward-filter by density (classic photographic filter).
  vec3 tinted = c * u_filter;
  c = mix(c, tinted, u_density);
  if (u_preserveLumP) {
    float lumAfter = luma709(c);
    c *= lumAfter > 1e-4 ? (lumBefore / lumAfter) : 1.0;
    c = clamp(c, 0.0, 1.0);
  }
`),
    ),
    setUniforms: (gl, loc, p) => {
      const col = colorFromParams(p.color, { r: 0.92, g: 0.6, b: 0.2, a: 1 });
      gl.uniform3f(loc("u_filter"), col.r, col.g, col.b);
      gl.uniform1f(loc("u_density"), num(p.density, 0.25));
      gl.uniform1i(loc("u_preserveLumP"), bool(p.preserveLuminosity, true) ? 1 : 0);
    },
  },

  // Channel Mixer — output each channel as a weighted sum of inputs + constant.
  channel_mixer: {
    type: "channel_mixer",
    label: "Channel Mixer",
    defaults: {
      rr: 1, rg: 0, rb: 0, rc: 0,
      gr: 0, gg: 1, gb: 0, gc: 0,
      br: 0, bg: 0, bb: 1, bc: 0,
      monochrome: false,
    },
    paramsSchema: [
      { kind: "checkbox", key: "monochrome", label: "Monochrome", default: false },
      { kind: "slider", key: "rr", label: "Red <- Red", min: -2, max: 2, step: 0.01, default: 1 },
      { kind: "slider", key: "rg", label: "Red <- Green", min: -2, max: 2, step: 0.01, default: 0 },
      { kind: "slider", key: "rb", label: "Red <- Blue", min: -2, max: 2, step: 0.01, default: 0 },
      { kind: "slider", key: "rc", label: "Red Constant", min: -1, max: 1, step: 0.01, default: 0 },
      { kind: "slider", key: "gr", label: "Green <- Red", min: -2, max: 2, step: 0.01, default: 0 },
      { kind: "slider", key: "gg", label: "Green <- Green", min: -2, max: 2, step: 0.01, default: 1 },
      { kind: "slider", key: "gb", label: "Green <- Blue", min: -2, max: 2, step: 0.01, default: 0 },
      { kind: "slider", key: "gc", label: "Green Constant", min: -1, max: 1, step: 0.01, default: 0 },
      { kind: "slider", key: "br", label: "Blue <- Red", min: -2, max: 2, step: 0.01, default: 0 },
      { kind: "slider", key: "bg", label: "Blue <- Green", min: -2, max: 2, step: 0.01, default: 0 },
      { kind: "slider", key: "bb", label: "Blue <- Blue", min: -2, max: 2, step: 0.01, default: 1 },
      { kind: "slider", key: "bc", label: "Blue Constant", min: -1, max: 1, step: 0.01, default: 0 },
    ],
    fragSource: makeShader(
      /* glsl */ `
uniform mat3 u_mix;     // rows = output channel weights (column-major upload)
uniform vec3 u_const;   // per-channel constants
uniform bool u_mono;
` +
        srgbBody(/* glsl */ `
  vec3 o = u_mix * c + u_const;
  if (u_mono) o = vec3(o.r);
  c = clamp(o, 0.0, 1.0);
`),
    ),
    setUniforms: (gl, loc, p) => {
      // Column-major mat3: column k = contribution OF input k. We want
      // o.r = rr*c.r + rg*c.g + rb*c.b, i.e. row 0 = (rr,rg,rb). In column-major
      // that's [rr,gr,br, rg,gg,bg, rb,gb,bb].
      const m = new Float32Array([
        num(p.rr, 1), num(p.gr), num(p.br),
        num(p.rg), num(p.gg, 1), num(p.bg),
        num(p.rb), num(p.gb), num(p.bb, 1),
      ]);
      gl.uniformMatrix3fv(loc("u_mix"), false, m);
      gl.uniform3f(loc("u_const"), num(p.rc), num(p.gc), num(p.bc));
      gl.uniform1i(loc("u_mono"), bool(p.monochrome) ? 1 : 0);
    },
  },

  // Invert — straightforward sRGB inversion (matches PS).
  invert: {
    type: "invert",
    label: "Invert",
    defaults: {},
    paramsSchema: [],
    fragSource: makeShader(srgbBody(/* glsl */ `c = 1.0 - c;`)),
  },

  // Posterize — quantize to N levels per channel (sRGB).
  posterize: {
    type: "posterize",
    label: "Posterize",
    defaults: { levels: 4 },
    paramsSchema: [
      { kind: "slider", key: "levels", label: "Levels", min: 2, max: 255, step: 1, default: 4 },
    ],
    fragSource: makeShader(
      /* glsl */ `
uniform float u_levels;
` +
        srgbBody(/* glsl */ `
  float n = max(2.0, u_levels);
  c = floor(c * n) / (n - 1.0);
  c = clamp(c, 0.0, 1.0);
`),
    ),
    setUniforms: (gl, loc, p) => {
      gl.uniform1f(loc("u_levels"), Math.round(num(p.levels, 4)));
    },
  },

  // Threshold — binarize on luma at a level (sRGB-domain luma like PS).
  threshold: {
    type: "threshold",
    label: "Threshold",
    defaults: { level: 0.5 },
    paramsSchema: [
      { kind: "slider", key: "level", label: "Level", min: 0, max: 1, step: 0.004, default: 0.5 },
    ],
    fragSource: makeShader(
      /* glsl */ `
uniform float u_level;
` +
        srgbBody(/* glsl */ `
  float l = dot(c, vec3(0.299, 0.587, 0.114));
  c = vec3(l >= u_level ? 1.0 : 0.0);
`),
    ),
    setUniforms: (gl, loc, p) => {
      gl.uniform1f(loc("u_level"), num(p.level, 0.5));
    },
  },

  // Gradient Map — map luma to a gradient (LUT in sRGB domain).
  gradient_map: {
    type: "gradient_map",
    label: "Gradient Map",
    defaults: {
      stops: [
        { pos: 0, color: { r: 0, g: 0, b: 0, a: 1 } },
        { pos: 1, color: { r: 1, g: 1, b: 1, a: 1 } },
      ],
    },
    paramsSchema: [
      {
        kind: "gradient",
        key: "stops",
        label: "Gradient",
        default: [
          { pos: 0, color: { r: 0, g: 0, b: 0, a: 1 } },
          { pos: 1, color: { r: 1, g: 1, b: 1, a: 1 } },
        ],
      },
    ],
    needsLUT: true,
    buildLUT: (p) => {
      const stops = normalizeStops(p.stops as GradientStop[] | undefined);
      const lut = new Uint8Array(256 * 4);
      for (let i = 0; i < 256; i++) {
        const t = i / 255;
        const col = sampleGradient(stops, t);
        lut[i * 4] = Math.round(clamp01(col.r) * 255);
        lut[i * 4 + 1] = Math.round(clamp01(col.g) * 255);
        lut[i * 4 + 2] = Math.round(clamp01(col.b) * 255);
        lut[i * 4 + 3] = 255;
      }
      return lut;
    },
    fragSource: makeShader(
      /* glsl */ `
uniform sampler2D u_lut;
` +
        srgbBody(/* glsl */ `
  float l = dot(c, vec3(0.299, 0.587, 0.114));
  c = texture(u_lut, vec2(l, 0.5)).rgb;
`),
    ),
  },
};

/** Ordered list for menus (matches a sensible Image > Adjustments order). */
export const ADJUSTMENT_ORDER: AdjustmentType[] = [
  "brightness_contrast",
  "levels",
  "curves",
  "exposure",
  "vibrance",
  "hue_saturation",
  "color_balance",
  "black_white",
  "photo_filter",
  "channel_mixer",
  "invert",
  "posterize",
  "threshold",
  "gradient_map",
];

/** Deep-clone an adjustment's defaults so each layer gets its own params. */
export function defaultAdjustmentParams(type: AdjustmentType): AdjustmentParams {
  return structuredClone(ADJUSTMENTS[type].defaults);
}

// ── param coercion helpers (shared with the engine) ──────
function num(v: unknown, fallback = 0): number {
  return typeof v === "number" && Number.isFinite(v) ? v : fallback;
}
function bool(v: unknown, fallback = false): boolean {
  return typeof v === "boolean" ? v : fallback;
}
function vec3FromParams(
  p: AdjustmentParams,
  groupKey: string,
  rk: string,
  gk: string,
  bk: string,
): [number, number, number] {
  const grp = p[groupKey];
  if (Array.isArray(grp) && grp.length >= 3) {
    return [num(grp[0]), num(grp[1]), num(grp[2])];
  }
  return [num(p[rk]), num(p[gk]), num(p[bk])];
}
function colorFromParams(
  v: unknown,
  fallback: { r: number; g: number; b: number; a: number },
): { r: number; g: number; b: number; a: number } {
  if (v && typeof v === "object") {
    const o = v as Record<string, unknown>;
    return {
      r: num(o.r, fallback.r),
      g: num(o.g, fallback.g),
      b: num(o.b, fallback.b),
      a: num(o.a, fallback.a),
    };
  }
  return fallback;
}

function normalizeStops(stops: GradientStop[] | undefined): GradientStop[] {
  if (!stops || stops.length === 0) {
    return [
      { pos: 0, color: { r: 0, g: 0, b: 0, a: 1 } },
      { pos: 1, color: { r: 1, g: 1, b: 1, a: 1 } },
    ];
  }
  return [...stops].sort((a, b) => a.pos - b.pos);
}

function sampleGradient(
  stops: GradientStop[],
  t: number,
): { r: number; g: number; b: number } {
  if (t <= stops[0]!.pos) return stops[0]!.color;
  if (t >= stops[stops.length - 1]!.pos) return stops[stops.length - 1]!.color;
  for (let i = 0; i < stops.length - 1; i++) {
    const a = stops[i]!;
    const b = stops[i + 1]!;
    if (t >= a.pos && t <= b.pos) {
      const span = b.pos - a.pos;
      const f = span > 1e-6 ? (t - a.pos) / span : 0;
      return {
        r: a.color.r + (b.color.r - a.color.r) * f,
        g: a.color.g + (b.color.g - a.color.g) * f,
        b: a.color.b + (b.color.b - a.color.b) * f,
      };
    }
  }
  return stops[stops.length - 1]!.color;
}

// Re-export for callers that need to build LUTs / sample gradients (gradient
// fill tool reuses sampleGradient via the engine).
export { srgbToLin, sampleGradient, normalizeStops };
