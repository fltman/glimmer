/**
 * GLSL ES 3.00 shader sources for the WebGL2 compositor.
 *
 * Color management rule (from the plan): we composite in LINEAR light. Source
 * sRGB textures are uploaded as SRGB8_ALPHA8 so the GPU decodes to linear on
 * sample for free. The present pass encodes linear -> sRGB exactly once, draws
 * a checkerboard behind transparency, and applies a small ordered dither to
 * hide banding on 8-bit output.
 */

export const QUAD_VERT = /* glsl */ `#version 300 es
precision highp float;

// Unit quad in [0,1]^2; a_uv carries the same coords for texturing.
layout(location = 0) in vec2 a_pos;
layout(location = 1) in vec2 a_uv;

uniform mat3 u_transform; // maps quad-space [0,1] -> clip space

out vec2 v_uv;

void main() {
  v_uv = a_uv;
  vec3 clip = u_transform * vec3(a_pos, 1.0);
  gl_Position = vec4(clip.xy, 0.0, 1.0);
}
`;

/**
 * Textured-quad / Normal source-over blend. Samples a premultiplied-alpha
 * source (linear) and applies per-layer opacity. The accumulator FBO is in
 * premultiplied linear space, so we blend with glBlendFunc(ONE, 1-SRC_ALPHA).
 */
export const BLEND_NORMAL_FRAG = /* glsl */ `#version 300 es
precision highp float;

in vec2 v_uv;
out vec4 fragColor;

uniform sampler2D u_tex;
uniform float u_opacity;   // 0..1 layer opacity
uniform bool u_srgbSource; // true when sampling a non-sRGB-decoding texture (RGBA8 fallback)

vec3 srgbToLinear(vec3 c) {
  return mix(c / 12.92, pow((c + 0.055) / 1.055, vec3(2.4)), step(0.04045, c));
}

void main() {
  vec4 src = texture(u_tex, v_uv);
  // If the texture wasn't an SRGB internal format, decode here. Premultiply
  // is preserved because we decode RGB and scale by the (unchanged) alpha path
  // below assuming straight-alpha source bitmaps.
  if (u_srgbSource) {
    src.rgb = srgbToLinear(src.rgb);
  }
  // Bitmaps arrive straight-alpha; premultiply for correct linear compositing.
  src.rgb *= src.a;
  fragColor = src * u_opacity;
}
`;

/**
 * FULL blend fragment shader — the Phase 2 compositor core.
 *
 * Implements the complete Photoshop / W3C "Compositing and Blending Level 1"
 * separable AND non-separable blend modes, selected by an int uniform
 * (`u_blendMode`, indices match BLEND_MODE_INDEX in Document.ts).
 *
 * IMPORTANT semantics — this shader does NOT use fixed-function GL blending for
 * the color math; it reads the current backdrop from `u_backdrop` (the
 * accumulator copy), blends per the W3C spec, and outputs a PREMULTIPLIED
 * source-over result that is written with glBlendFunc(ONE, ONE_MINUS_SRC_ALPHA)
 * — but because we already incorporate the backdrop, the engine binds this with
 * blend DISABLED and writes the full composited pixel (see EditorEngine).
 *
 * All math is in LINEAR light, straight (un-premultiplied) color per the spec's
 * B(Cb,Cs) formulation, then re-composited with Porter-Duff source-over using
 * the W3C blend-compositing formula:
 *   Co = αs·(1-αb)·Cs + αs·αb·B(Cb,Cs) + (1-αs)·αb·Cb     (premultiplied out)
 *   αo = αs + αb·(1-αs)
 *
 * Effective source alpha = layer.a * u_opacity * mask(uv) * selection(docUV).
 */
export const BLEND_FRAG = /* glsl */ `#version 300 es
precision highp float;

in vec2 v_uv;
out vec4 fragColor;

uniform sampler2D u_tex;        // source layer (sRGB-decoding or RGBA8), straight alpha
uniform sampler2D u_backdrop;   // current accumulator (linear, PREMULTIPLIED)
uniform sampler2D u_mask;       // layer mask, R channel 0..1 (layer-local uv)
uniform sampler2D u_selection;  // document selection mask, R channel 0..1

uniform float u_opacity;        // 0..1 layer opacity
uniform bool  u_srgbSource;     // decode sRGB in-shader (RGBA8 fallback path)
uniform bool  u_useMask;        // sample u_mask
uniform bool  u_useSelection;   // sample u_selection (mask painting / region edits)
uniform int   u_blendMode;      // see BLEND_MODE_INDEX
uniform vec2  u_backdropSize;   // accumulator size in px (for gl_FragCoord lookup)
uniform mat3  u_uvToSel;        // maps layer quad uv [0,1] -> selection uv [0,1]

vec3 srgbToLinear(vec3 c) {
  return mix(c / 12.92, pow((c + 0.055) / 1.055, vec3(2.4)), step(0.04045, c));
}

// ── separable per-channel blend functions B(Cb,Cs) on straight color ──
float bMultiply(float b, float s)  { return b * s; }
float bScreen(float b, float s)    { return b + s - b * s; }
float bHardLight(float b, float s) {
  return s <= 0.5 ? bMultiply(b, 2.0 * s) : bScreen(b, 2.0 * s - 1.0);
}
float bOverlay(float b, float s)   { return bHardLight(s, b); }
float bDarken(float b, float s)    { return min(b, s); }
float bLighten(float b, float s)   { return max(b, s); }
float bColorDodge(float b, float s) {
  if (b <= 0.0) return 0.0;
  if (s >= 1.0) return 1.0;
  return min(1.0, b / (1.0 - s));
}
float bColorBurn(float b, float s) {
  if (b >= 1.0) return 1.0;
  if (s <= 0.0) return 0.0;
  return 1.0 - min(1.0, (1.0 - b) / s);
}
float bSoftLight(float b, float s) {
  float d = b <= 0.25 ? ((16.0 * b - 12.0) * b + 4.0) * b : sqrt(b);
  return s <= 0.5
    ? b - (1.0 - 2.0 * s) * b * (1.0 - b)
    : b + (2.0 * s - 1.0) * (d - b);
}
float bDifference(float b, float s) { return abs(b - s); }
float bExclusion(float b, float s)  { return b + s - 2.0 * b * s; }
float bLinearBurn(float b, float s) { return clamp(b + s - 1.0, 0.0, 1.0); }
float bLinearDodge(float b, float s){ return clamp(b + s, 0.0, 1.0); }

vec3 blendSeparable(int mode, vec3 cb, vec3 cs) {
  if (mode == 1)  return vec3(bMultiply(cb.r, cs.r),  bMultiply(cb.g, cs.g),  bMultiply(cb.b, cs.b));
  if (mode == 2)  return vec3(bScreen(cb.r, cs.r),    bScreen(cb.g, cs.g),    bScreen(cb.b, cs.b));
  if (mode == 3)  return vec3(bOverlay(cb.r, cs.r),   bOverlay(cb.g, cs.g),   bOverlay(cb.b, cs.b));
  if (mode == 4)  return vec3(bDarken(cb.r, cs.r),    bDarken(cb.g, cs.g),    bDarken(cb.b, cs.b));
  if (mode == 5)  return vec3(bLighten(cb.r, cs.r),   bLighten(cb.g, cs.g),   bLighten(cb.b, cs.b));
  if (mode == 6)  return vec3(bColorDodge(cb.r, cs.r),bColorDodge(cb.g, cs.g),bColorDodge(cb.b, cs.b));
  if (mode == 7)  return vec3(bColorBurn(cb.r, cs.r), bColorBurn(cb.g, cs.g), bColorBurn(cb.b, cs.b));
  if (mode == 8)  return vec3(bHardLight(cb.r, cs.r), bHardLight(cb.g, cs.g), bHardLight(cb.b, cs.b));
  if (mode == 9)  return vec3(bSoftLight(cb.r, cs.r), bSoftLight(cb.g, cs.g), bSoftLight(cb.b, cs.b));
  if (mode == 10) return vec3(bDifference(cb.r, cs.r),bDifference(cb.g, cs.g),bDifference(cb.b, cs.b));
  if (mode == 11) return vec3(bExclusion(cb.r, cs.r), bExclusion(cb.g, cs.g), bExclusion(cb.b, cs.b));
  if (mode == 12) return vec3(bLinearDodge(cb.r, cs.r),bLinearDodge(cb.g, cs.g),bLinearDodge(cb.b, cs.b));
  if (mode == 13) return vec3(bLinearBurn(cb.r, cs.r),bLinearBurn(cb.g, cs.g),bLinearBurn(cb.b, cs.b));
  return cs; // 0 normal
}

// ── non-separable blend helpers (W3C spec) ──
float lum(vec3 c) { return dot(c, vec3(0.3, 0.59, 0.11)); }
vec3 clipColor(vec3 c) {
  float l = lum(c);
  float n = min(min(c.r, c.g), c.b);
  float x = max(max(c.r, c.g), c.b);
  if (n < 0.0) c = l + (c - l) * (l / max(l - n, 1e-6));
  if (x > 1.0) c = l + (c - l) * ((1.0 - l) / max(x - l, 1e-6));
  return c;
}
vec3 setLum(vec3 c, float l) { return clipColor(c + (l - lum(c))); }
float sat(vec3 c) { return max(max(c.r, c.g), c.b) - min(min(c.r, c.g), c.b); }
// Set saturation per spec (operate on min/mid/max channels).
vec3 setSat(vec3 c, float s) {
  float cMin = min(min(c.r, c.g), c.b);
  float cMax = max(max(c.r, c.g), c.b);
  vec3 res = vec3(0.0);
  if (cMax > cMin) {
    // r
    res.r = (c.r == cMin) ? 0.0 : (c.r == cMax ? s : ((c.r - cMin) / (cMax - cMin)) * s);
    res.g = (c.g == cMin) ? 0.0 : (c.g == cMax ? s : ((c.g - cMin) / (cMax - cMin)) * s);
    res.b = (c.b == cMin) ? 0.0 : (c.b == cMax ? s : ((c.b - cMin) / (cMax - cMin)) * s);
  }
  return res;
}
vec3 blendNonSeparable(int mode, vec3 cb, vec3 cs) {
  if (mode == 14) return setLum(setSat(cs, sat(cb)), lum(cb)); // hue
  if (mode == 15) return setLum(setSat(cb, sat(cs)), lum(cb)); // saturation
  if (mode == 16) return setLum(cs, lum(cb));                  // color
  if (mode == 17) return setLum(cb, lum(cs));                  // luminosity
  return cs;
}

void main() {
  vec4 src = texture(u_tex, v_uv);
  if (u_srgbSource) src.rgb = srgbToLinear(src.rgb);
  // src arrives straight-alpha; keep straight color (Cs) for the blend math.
  vec3 cs = src.rgb;

  // Effective source alpha.
  float as = src.a * u_opacity;
  if (u_useMask) as *= texture(u_mask, v_uv).r;
  if (u_useSelection) {
    vec3 sUv = u_uvToSel * vec3(v_uv, 1.0);
    as *= texture(u_selection, sUv.xy).r;
  }

  // Backdrop (premultiplied linear) — recover straight color + alpha.
  vec2 bUv = gl_FragCoord.xy / u_backdropSize;
  vec4 bp = texture(u_backdrop, bUv);
  float ab = bp.a;
  vec3 cb = ab > 1e-5 ? bp.rgb / ab : vec3(0.0);

  // B(Cb,Cs) per mode (straight color, linear).
  vec3 blended;
  if (u_blendMode >= 14) blended = blendNonSeparable(u_blendMode, cb, cs);
  else                   blended = blendSeparable(u_blendMode, cb, cs);

  // W3C blend-composite: the source's "effective" color mixes pure source with
  // the blended result by the backdrop alpha, then standard source-over.
  //   Cs' = (1 - αb)·Cs + αb·B(Cb,Cs)
  vec3 csEff = mix(cs, blended, ab);
  float ao = as + ab * (1.0 - as);
  // Output PREMULTIPLIED.
  vec3 co = as * csEff + ab * (1.0 - as) * cb;
  fragColor = vec4(co, ao);
}
`;

/**
 * Present pass: samples the linear premultiplied composite, un-premultiplies,
 * composites over a checkerboard, encodes to sRGB, and adds ordered dither.
 */
export const PRESENT_FRAG = /* glsl */ `#version 300 es
precision highp float;

in vec2 v_uv;
out vec4 fragColor;

uniform sampler2D u_composite; // linear, premultiplied
uniform vec2 u_viewport;       // drawing-buffer size in px
uniform float u_checkSize;     // checker tile size in px

vec3 linearToSrgb(vec3 c) {
  return mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(0.0031308, c));
}

// 4x4 Bayer ordered-dither matrix, scaled to ~1/255.
float dither(vec2 fragCoord) {
  int x = int(mod(fragCoord.x, 4.0));
  int y = int(mod(fragCoord.y, 4.0));
  int idx = y * 4 + x;
  float m[16] = float[16](
    0.0, 8.0, 2.0, 10.0,
    12.0, 4.0, 14.0, 6.0,
    3.0, 11.0, 1.0, 9.0,
    15.0, 7.0, 13.0, 5.0
  );
  return (m[idx] / 16.0 - 0.5) / 255.0;
}

void main() {
  vec4 c = texture(u_composite, v_uv);
  // Un-premultiply to recover straight color + alpha.
  vec3 rgb = c.a > 0.0001 ? c.rgb / c.a : vec3(0.0);

  // Checkerboard backdrop (in display space).
  vec2 px = gl_FragCoord.xy;
  vec2 cell = floor(px / u_checkSize);
  float checker = mod(cell.x + cell.y, 2.0);
  vec3 bg = mix(vec3(0.18), vec3(0.26), checker);

  // Composite straight color over backdrop using alpha.
  vec3 outLinear = mix(bg, rgb, clamp(c.a, 0.0, 1.0));
  vec3 srgb = linearToSrgb(outLinear) + dither(px);
  fragColor = vec4(clamp(srgb, 0.0, 1.0), 1.0);
}
`;

// ──────────────────────────────────────────────────────────────
// Selection / mask shaders (single-channel R8 / R16F targets)
// ──────────────────────────────────────────────────────────────

/**
 * Pass-through vertex shader for full-document overlays. a_pos in [0,1] is
 * mapped to clip via u_transform exactly like QUAD_VERT, but also passes the
 * document-space [0,1] coords so fragment shaders can rasterize geometry.
 */
export const SEL_VERT = QUAD_VERT;

/**
 * Rasterize a marquee primitive into the selection mask. Geometry is given in
 * normalized document coords (0..1). Outputs a coverage value 0..1 in R; the
 * caller combines it with the existing mask via the boolean op (add/subtract/
 * intersect) using fixed-function blending or u_op math.
 *
 * u_shape: 0 = rectangle, 1 = ellipse.
 * u_rect:  (x0, y0, x1, y1) in normalized doc coords.
 */
export const SEL_SHAPE_FRAG = /* glsl */ `#version 300 es
precision highp float;
in vec2 v_uv;            // normalized document coords 0..1
out vec4 fragColor;
uniform int  u_shape;    // 0 rect, 1 ellipse
uniform vec4 u_rect;     // x0,y0,x1,y1 normalized
uniform vec2 u_docSize;  // doc px (for AA edge width)

void main() {
  vec2 lo = min(u_rect.xy, u_rect.zw);
  vec2 hi = max(u_rect.xy, u_rect.zw);
  float cov = 0.0;
  // ~1px feather at the geometry edge for crisp but anti-aliased marquees.
  vec2 aa = 1.0 / max(u_docSize, vec2(1.0));
  if (u_shape == 0) {
    vec2 a = smoothstep(lo - aa, lo + aa, v_uv);
    vec2 b = smoothstep(hi + aa, hi - aa, v_uv);
    cov = a.x * a.y * b.x * b.y;
  } else {
    vec2 c = 0.5 * (lo + hi);
    vec2 r = max(0.5 * (hi - lo), aa);
    vec2 d = (v_uv - c) / r;
    float dist = length(d);
    float edge = max(aa.x / r.x, aa.y / r.y);
    cov = 1.0 - smoothstep(1.0 - edge, 1.0 + edge, dist);
  }
  fragColor = vec4(cov, 0.0, 0.0, 1.0);
}
`;

/**
 * Combine a freshly rasterized shape (u_shape stamp) with the existing
 * selection using a boolean op. Both inputs are single-channel.
 *   u_op: 0 replace, 1 add (max), 2 subtract, 3 intersect (min).
 */
export const SEL_COMBINE_FRAG = /* glsl */ `#version 300 es
precision highp float;
in vec2 v_uv;
out vec4 fragColor;
uniform sampler2D u_existing;
uniform sampler2D u_stamp;
uniform int u_op;
void main() {
  float a = texture(u_existing, v_uv).r;
  float b = texture(u_stamp, v_uv).r;
  float o = b;
  if (u_op == 1) o = max(a, b);
  else if (u_op == 2) o = a * (1.0 - b);
  else if (u_op == 3) o = min(a, b);
  fragColor = vec4(o, 0.0, 0.0, 1.0);
}
`;

/**
 * Separable Gaussian blur for feathering a single-channel mask. Run twice
 * (horizontal then vertical) with u_dir = (1/w,0) and (0,1/h).
 */
export const BLUR_FRAG = /* glsl */ `#version 300 es
precision highp float;
in vec2 v_uv;
out vec4 fragColor;
uniform sampler2D u_src;
uniform vec2 u_dir;     // texel step along the blur axis
uniform int  u_radius;  // kernel radius in texels (<= 32)
uniform float u_sigma;
void main() {
  float sum = 0.0;
  float wsum = 0.0;
  float s2 = 2.0 * u_sigma * u_sigma;
  for (int i = -32; i <= 32; i++) {
    if (i < -u_radius || i > u_radius) continue;
    float fi = float(i);
    float w = exp(-(fi * fi) / s2);
    sum += texture(u_src, v_uv + u_dir * fi).r * w;
    wsum += w;
  }
  fragColor = vec4(wsum > 0.0 ? sum / wsum : 0.0, 0.0, 0.0, 1.0);
}
`;

/**
 * Marching-ants overlay drawn in the present/overlay pass. Samples the
 * selection mask, finds the ~0.5 contour by comparing the local value against
 * its neighbours, and draws an animated dashed line there. Crisp under zoom
 * because the dash phase is driven by screen-space fragment coords.
 */
export const ANTS_FRAG = /* glsl */ `#version 300 es
precision highp float;
in vec2 v_uv;            // selection uv 0..1 mapped to the document quad
out vec4 fragColor;
uniform sampler2D u_selection;
uniform vec2 u_selSize;  // selection texture size in px
uniform float u_phase;   // animated dash phase (time-based)

void main() {
  float c = texture(u_selection, v_uv).r;
  vec2 t = 1.0 / u_selSize;
  // Edge detection on the 0.5 iso-contour.
  float l = texture(u_selection, v_uv - vec2(t.x, 0.0)).r;
  float r = texture(u_selection, v_uv + vec2(t.x, 0.0)).r;
  float d = texture(u_selection, v_uv - vec2(0.0, t.y)).r;
  float u = texture(u_selection, v_uv + vec2(0.0, t.y)).r;
  float edge =
    step(0.5, max(max(l, r), max(d, u))) * (1.0 - step(0.5, min(min(l, r), min(d, u))));
  if (edge < 0.5) { discard; }
  // Dashed pattern in screen space.
  float dash = mod(gl_FragCoord.x + gl_FragCoord.y + u_phase, 12.0);
  vec3 col = dash < 6.0 ? vec3(1.0) : vec3(0.0);
  fragColor = vec4(col, 1.0);
}
`;

// ──────────────────────────────────────────────────────────────
// Brush engine shaders
// ──────────────────────────────────────────────────────────────

/**
 * Stamp a single soft-round dab into the wet stroke buffer. The dab is drawn as
 * a unit quad transformed to the dab's bounding box (u_transform). Falloff is
 * a smooth radial gradient governed by hardness. Writes coverage into R
 * (single-channel wet buffer) using MAX blending so overlapping dabs within one
 * stroke don't darken (Photoshop "build-up off" behaviour).
 */
export const DAB_FRAG = /* glsl */ `#version 300 es
precision highp float;
in vec2 v_uv;            // 0..1 across the dab quad
out vec4 fragColor;
uniform float u_hardness; // 0..1 (1 = hard edge)
uniform float u_flow;     // 0..1 per-dab coverage
uniform sampler2D u_selection; // doc selection mask
uniform bool u_useSelection;
uniform mat3 u_uvToSel;   // dab uv -> selection uv

void main() {
  vec2 d = v_uv * 2.0 - 1.0;       // -1..1
  float r = length(d);
  if (r > 1.0) discard;
  // Soft radial falloff: hardness controls where the falloff begins.
  float inner = clamp(u_hardness, 0.0, 0.98);
  float cov = 1.0 - smoothstep(inner, 1.0, r);
  cov *= u_flow;
  if (u_useSelection) {
    vec3 sUv = u_uvToSel * vec3(v_uv, 1.0);
    cov *= texture(u_selection, sUv.xy).r;
  }
  fragColor = vec4(cov, 0.0, 0.0, 1.0);
}
`;

/**
 * Composite the wet stroke buffer (single-channel coverage) onto a target,
 * either as a colored paint stroke (brush) or as an alpha erase. Used to flatten
 * the stroke into the active layer on pointer-up and to show a live preview.
 *
 *   u_mode 0: paint  -> out = layer over by (color, cov*opacity)  [premultiplied? no — straight]
 *   u_mode 1: erase  -> out.a = layer.a * (1 - cov*opacity)
 *
 * Works on STRAIGHT-alpha RGBA8 layer textures (the brush flatten path renders
 * to an RGBA8 target that becomes the new layer source).
 */
export const STROKE_APPLY_FRAG = /* glsl */ `#version 300 es
precision highp float;
in vec2 v_uv;
out vec4 fragColor;
uniform sampler2D u_layer;   // existing layer pixels (straight alpha, sRGB-decoding)
uniform sampler2D u_wet;     // wet stroke coverage (R)
uniform vec3 u_color;        // brush color (linear)
uniform float u_opacity;     // stroke master opacity 0..1
uniform int u_mode;          // 0 paint, 1 erase
uniform bool u_srgbLayer;    // decode layer in-shader (RGBA8 path)

vec3 srgbToLinear(vec3 c) {
  return mix(c / 12.92, pow((c + 0.055) / 1.055, vec3(2.4)), step(0.04045, c));
}
vec3 linearToSrgb(vec3 c) {
  return mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(0.0031308, c));
}

void main() {
  vec4 base = texture(u_layer, v_uv);
  vec3 baseLin = u_srgbLayer ? srgbToLinear(base.rgb) : base.rgb;
  float cov = texture(u_wet, v_uv).r * u_opacity;

  vec4 outc;
  if (u_mode == 1) {
    // Erase: reduce alpha, keep color.
    outc = vec4(baseLin, base.a * (1.0 - cov));
  } else {
    // Paint source-over (straight alpha) in linear light.
    float a = base.a;
    float oa = cov + a * (1.0 - cov);
    vec3 oc = oa > 1e-5 ? (u_color * cov + baseLin * a * (1.0 - cov)) / oa : vec3(0.0);
    outc = vec4(oc, oa);
  }
  // Re-encode to sRGB for the RGBA8 layer store.
  fragColor = vec4(linearToSrgb(outc.rgb), outc.a);
}
`;

/**
 * Paint the wet stroke coverage directly into a single-channel mask (layer mask
 * editing). out = clamp(mask ± cov*opacity). u_erase flips the sign.
 */
export const MASK_PAINT_FRAG = /* glsl */ `#version 300 es
precision highp float;
in vec2 v_uv;
out vec4 fragColor;
uniform sampler2D u_mask;
uniform sampler2D u_wet;
uniform float u_opacity;
uniform bool u_erase;   // true = paint black (hide), false = paint white (reveal)
void main() {
  float m = texture(u_mask, v_uv).r;
  float cov = texture(u_wet, v_uv).r * u_opacity;
  float o = u_erase ? m * (1.0 - cov) : max(m, cov);
  fragColor = vec4(clamp(o, 0.0, 1.0), 0.0, 0.0, 1.0);
}
`;

/**
 * Trivial single-channel blit (copy R from src to a target), used to seed /
 * snapshot mask buffers.
 */
export const R_COPY_FRAG = /* glsl */ `#version 300 es
precision highp float;
in vec2 v_uv;
out vec4 fragColor;
uniform sampler2D u_src;
void main() {
  fragColor = vec4(texture(u_src, v_uv).r, 0.0, 0.0, 1.0);
}
`;

/**
 * Morphological dilate / erode of a single-channel (R8) mask. For each texel we
 * take the max (dilate / grow) or min (erode / shrink) over a square kernel of
 * radius `u_radius` texels. Used by Selection.expand()/contract() — run once per
 * call (radius up to 32). Edge-out-of-bounds samples clamp (CLAMP_TO_EDGE), so
 * erode near a border shrinks correctly and dilate spreads to the border.
 *   u_mode: 0 = dilate (max), 1 = erode (min).
 */
export const MORPH_FRAG = /* glsl */ `#version 300 es
precision highp float;
in vec2 v_uv;
out vec4 fragColor;
uniform sampler2D u_src;
uniform vec2 u_texel;   // 1/size
uniform int  u_radius;  // kernel radius in texels (<= 32)
uniform int  u_mode;    // 0 dilate (max), 1 erode (min)
void main() {
  float acc = u_mode == 1 ? 1.0 : 0.0;
  for (int dy = -32; dy <= 32; dy++) {
    if (dy < -u_radius || dy > u_radius) continue;
    for (int dx = -32; dx <= 32; dx++) {
      if (dx < -u_radius || dx > u_radius) continue;
      // Circular kernel for rounder grow/shrink.
      if (dx * dx + dy * dy > u_radius * u_radius) continue;
      float s = texture(u_src, v_uv + u_texel * vec2(float(dx), float(dy))).r;
      acc = u_mode == 1 ? min(acc, s) : max(acc, s);
    }
  }
  fragColor = vec4(acc, 0.0, 0.0, 1.0);
}
`;

/** Invert a single-channel (R8) mask: out = 1 - in. */
export const R_INVERT_FRAG = /* glsl */ `#version 300 es
precision highp float;
in vec2 v_uv;
out vec4 fragColor;
uniform sampler2D u_src;
void main() {
  fragColor = vec4(1.0 - texture(u_src, v_uv).r, 0.0, 0.0, 1.0);
}
`;

// ──────────────────────────────────────────────────────────────
// Retouch-brush stroke-apply shaders
//
// These all read the EXISTING layer pixels (straight-alpha, sRGB-decoding or
// RGBA8) plus a single-channel wet coverage buffer, and write a new straight
// sRGB RGBA8 layer pixel. The retouch brushes apply DAB-by-DAB into a working
// copy of the layer (ping-pong) so neighbouring samples (clone source, smudge
// pickup, blur/sharpen) see the in-progress result, then the engine reads the
// working copy back on pointer-up as one undo step. Coverage * opacity (or
// strength/exposure) controls how strongly each dab modifies the destination.
// ──────────────────────────────────────────────────────────────

const RETOUCH_COLOR_FNS = /* glsl */ `
vec3 srgbToLinear(vec3 c) {
  return mix(c / 12.92, pow((c + 0.055) / 1.055, vec3(2.4)), step(0.04045, c));
}
vec3 linearToSrgb(vec3 c) {
  return mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(0.0031308, c));
}
float luma(vec3 c) { return dot(c, vec3(0.299, 0.587, 0.114)); }
`;

/**
 * CLONE STAMP apply pass. Copies pixels from a source offset (u_srcOffset, in
 * destination-uv units) over the destination, modulated by wet coverage. Source
 * and destination are the SAME working texture (aligned cloning samples the
 * already-painted result). Operates in straight sRGB display space (verbatim
 * RGBA8 store), so no linear round-trip is needed for a pure copy.
 *   u_decodeSrc: 1 when the bound layer texture is sRGB-decoding (pass 0).
 */
export const RETOUCH_CLONE_FRAG = /* glsl */ `#version 300 es
precision highp float;
in vec2 v_uv;
out vec4 fragColor;
uniform sampler2D u_layer;   // working layer copy (dst == src texture)
uniform sampler2D u_wet;     // wet coverage (R)
uniform vec2 u_srcOffset;    // dst uv -> src uv delta (sampleUv = v_uv + offset)
uniform float u_opacity;     // master stroke opacity
uniform bool u_decodeSrc;    // layer texture decodes sRGB on sample
${RETOUCH_COLOR_FNS}
void main() {
  vec4 dst = texture(u_layer, v_uv);
  if (u_decodeSrc) dst.rgb = linearToSrgb(dst.rgb); // back to display sRGB bytes
  vec2 sUv = v_uv + u_srcOffset;
  vec4 src;
  if (sUv.x < 0.0 || sUv.x > 1.0 || sUv.y < 0.0 || sUv.y > 1.0) {
    src = dst; // source outside the layer: leave destination unchanged
  } else {
    src = texture(u_layer, sUv);
    if (u_decodeSrc) src.rgb = linearToSrgb(src.rgb);
  }
  float cov = clamp(texture(u_wet, v_uv).r * u_opacity, 0.0, 1.0);
  // Source-over the source pixel onto the destination (premultiply-correct mix
  // in straight space): blend both color and alpha by coverage.
  float oa = mix(dst.a, src.a, cov);
  vec3 oc = mix(dst.rgb * dst.a, src.rgb * src.a, cov);
  oc = oa > 1e-5 ? oc / oa : vec3(0.0);
  fragColor = vec4(oc, oa);
}
`;

/**
 * HEALING BRUSH apply pass. Like clone, but transfers the source's HIGH-FREQUENCY
 * detail while keeping the destination's LOW-FREQUENCY color (a pragmatic
 * Poisson-lite): healed = dstLow + (src - srcLow). Low-frequency = a small box
 * blur sampled around each point. Result blends in linear light, modulated by
 * coverage. srcLow/dstLow are estimated with a fixed 9-tap blur at u_blurStep.
 */
export const RETOUCH_HEAL_FRAG = /* glsl */ `#version 300 es
precision highp float;
in vec2 v_uv;
out vec4 fragColor;
uniform sampler2D u_layer;
uniform sampler2D u_wet;
uniform vec2 u_srcOffset;
uniform vec2 u_blurStep;     // texel step for the low-freq estimate
uniform float u_opacity;
uniform bool u_decodeSrc;
${RETOUCH_COLOR_FNS}
vec3 sampleLin(vec2 uv) {
  vec3 c = texture(u_layer, clamp(uv, vec2(0.0), vec2(1.0))).rgb;
  return u_decodeSrc ? c : srgbToLinear(c);
}
vec3 lowFreq(vec2 uv) {
  vec3 s = vec3(0.0);
  for (int dy = -2; dy <= 2; dy++) {
    for (int dx = -2; dx <= 2; dx++) {
      s += sampleLin(uv + u_blurStep * vec2(float(dx), float(dy)));
    }
  }
  return s / 25.0;
}
void main() {
  vec4 dstRaw = texture(u_layer, v_uv);
  vec3 dstLin = u_decodeSrc ? dstRaw.rgb : srgbToLinear(dstRaw.rgb);
  vec2 sUv = v_uv + u_srcOffset;
  float cov = clamp(texture(u_wet, v_uv).r * u_opacity, 0.0, 1.0);
  if (sUv.x < 0.0 || sUv.x > 1.0 || sUv.y < 0.0 || sUv.y > 1.0 || cov <= 0.0) {
    // No usable source — pass the destination through (display sRGB store).
    vec3 disp = u_decodeSrc ? linearToSrgb(dstLin) : dstRaw.rgb;
    fragColor = vec4(disp, dstRaw.a);
    return;
  }
  vec3 srcLin = sampleLin(sUv);
  vec3 srcLow = lowFreq(sUv);
  vec3 dstLow = lowFreq(v_uv);
  // High-freq from source + low-freq color of destination.
  vec3 healedLin = clamp(dstLow + (srcLin - srcLow), 0.0, 1.0);
  vec3 outLin = mix(dstLin, healedLin, cov);
  float oa = max(dstRaw.a, cov);   // fill transparent dest gradually
  fragColor = vec4(linearToSrgb(outLin), oa);
}
`;

/**
 * DODGE / BURN apply pass. Lightens (dodge) or darkens (burn) the existing
 * pixels under the brush, weighted by a tonal-range mask (shadows/mids/
 * highlights) computed from destination luma. Works in linear light.
 *   u_mode: 0 dodge (lighten), 1 burn (darken).
 *   u_range: 0 shadows, 1 midtones, 2 highlights.
 *   exposure (u_exposure) scales the per-fragment effect by coverage.
 */
export const RETOUCH_DODGEBURN_FRAG = /* glsl */ `#version 300 es
precision highp float;
in vec2 v_uv;
out vec4 fragColor;
uniform sampler2D u_layer;
uniform sampler2D u_wet;
uniform float u_exposure;    // 0..1 strength
uniform int u_mode;          // 0 dodge, 1 burn
uniform int u_range;         // 0 shadows, 1 mids, 2 highlights
uniform bool u_decodeSrc;
${RETOUCH_COLOR_FNS}
void main() {
  vec4 base = texture(u_layer, v_uv);
  vec3 lin = u_decodeSrc ? base.rgb : srgbToLinear(base.rgb);
  float cov = texture(u_wet, v_uv).r;
  float l = luma(lin);
  // Tonal-range weight (Gaussian-ish bumps over the luma axis).
  float w;
  if (u_range == 0)      w = 1.0 - smoothstep(0.0, 0.5, l);          // shadows
  else if (u_range == 2) w = smoothstep(0.5, 1.0, l);                // highlights
  else                   w = 1.0 - abs(l - 0.5) * 2.0;               // midtones
  w = clamp(w, 0.0, 1.0);
  float amt = cov * u_exposure * w;
  vec3 outLin;
  if (u_mode == 1) {
    // Burn: scale toward black (Photoshop-like multiplicative darken).
    outLin = lin * (1.0 - amt * 0.9);
  } else {
    // Dodge: screen toward white.
    outLin = 1.0 - (1.0 - lin) * (1.0 - amt * 0.9);
  }
  outLin = clamp(outLin, 0.0, 1.0);
  fragColor = vec4(linearToSrgb(outLin), base.a);
}
`;

/**
 * SMUDGE apply pass. Drags color along the stroke: each dab pulls the previous
 * sample point's color toward the current position. We approximate the classic
 * "pick up + smear" by blending the destination with a sample taken a small step
 * BACK along the stroke direction (u_smearOffset, dst-uv units), modulated by
 * coverage * strength. Linear-light blend.
 */
export const RETOUCH_SMUDGE_FRAG = /* glsl */ `#version 300 es
precision highp float;
in vec2 v_uv;
out vec4 fragColor;
uniform sampler2D u_layer;
uniform sampler2D u_wet;
uniform vec2 u_smearOffset;  // dst uv -> pickup uv delta (sample behind motion)
uniform float u_strength;    // 0..1 carry amount
uniform bool u_decodeSrc;
${RETOUCH_COLOR_FNS}
void main() {
  vec4 base = texture(u_layer, v_uv);
  vec3 dstLin = u_decodeSrc ? base.rgb : srgbToLinear(base.rgb);
  vec2 pUv = clamp(v_uv + u_smearOffset, vec2(0.0), vec2(1.0));
  vec4 pick = texture(u_layer, pUv);
  vec3 pickLin = u_decodeSrc ? pick.rgb : srgbToLinear(pick.rgb);
  float cov = texture(u_wet, v_uv).r;
  float amt = clamp(cov * u_strength, 0.0, 1.0);
  vec3 outLin = mix(dstLin, pickLin, amt);
  float oa = mix(base.a, pick.a, amt);
  fragColor = vec4(linearToSrgb(outLin), oa);
}
`;

/**
 * BLUR / SHARPEN apply pass. Computes a 3x3 box blur of the destination; blur
 * mode mixes toward it, sharpen mode mixes away from it (unsharp mask). The mix
 * amount = coverage * strength. Linear-light.
 *   u_mode: 0 blur, 1 sharpen.
 */
export const RETOUCH_FOCUS_FRAG = /* glsl */ `#version 300 es
precision highp float;
in vec2 v_uv;
out vec4 fragColor;
uniform sampler2D u_layer;
uniform sampler2D u_wet;
uniform vec2 u_texel;        // 1/size
uniform float u_strength;    // 0..1
uniform int u_mode;          // 0 blur, 1 sharpen
uniform bool u_decodeSrc;
${RETOUCH_COLOR_FNS}
vec3 sampLin(vec2 uv) {
  vec3 c = texture(u_layer, clamp(uv, vec2(0.0), vec2(1.0))).rgb;
  return u_decodeSrc ? c : srgbToLinear(c);
}
void main() {
  vec4 base = texture(u_layer, v_uv);
  vec3 center = u_decodeSrc ? base.rgb : srgbToLinear(base.rgb);
  vec3 blur = vec3(0.0);
  for (int dy = -1; dy <= 1; dy++) {
    for (int dx = -1; dx <= 1; dx++) {
      blur += sampLin(v_uv + u_texel * vec2(float(dx), float(dy)));
    }
  }
  blur /= 9.0;
  float amt = clamp(texture(u_wet, v_uv).r * u_strength, 0.0, 1.0);
  vec3 outLin;
  if (u_mode == 1) {
    // Sharpen (unsharp): push away from the blurred neighbourhood.
    outLin = center + (center - blur) * amt * 1.5;
  } else {
    outLin = mix(center, blur, amt);
  }
  outLin = clamp(outLin, 0.0, 1.0);
  fragColor = vec4(linearToSrgb(outLin), base.a);
}
`;
