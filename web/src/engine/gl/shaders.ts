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
uniform sampler2D u_clip;       // clip base alpha (layer below), RGBA (clip uv)

uniform float u_opacity;        // 0..1 layer opacity
uniform bool  u_srgbSource;     // decode sRGB in-shader (RGBA8 fallback path)
uniform bool  u_premulSource;   // source is premultiplied LINEAR (group result) — unpremul, no sRGB decode
uniform bool  u_useMask;        // sample u_mask
uniform bool  u_useSelection;   // sample u_selection (mask painting / region edits)
uniform bool  u_useClip;        // clip this layer to the alpha of the layer below
uniform int   u_blendMode;      // see BLEND_MODE_INDEX
uniform vec2  u_backdropSize;   // accumulator size in px (for gl_FragCoord lookup)
uniform mat3  u_uvToSel;        // maps layer quad uv [0,1] -> selection uv [0,1]
uniform mat3  u_uvToClip;       // maps layer quad uv [0,1] -> clip-base uv [0,1]

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
  if (u_premulSource) {
    // Group result: premultiplied linear -> straight linear (no sRGB decode).
    src.rgb = src.a > 1e-5 ? src.rgb / src.a : vec3(0.0);
  } else if (u_srgbSource) {
    src.rgb = srgbToLinear(src.rgb);
  }
  // src arrives straight-alpha; keep straight color (Cs) for the blend math.
  vec3 cs = src.rgb;

  // Effective source alpha.
  float as = src.a * u_opacity;
  if (u_useMask) as *= texture(u_mask, v_uv).r;
  if (u_useSelection) {
    vec3 sUv = u_uvToSel * vec3(v_uv, 1.0);
    as *= texture(u_selection, sUv.xy).r;
  }
  if (u_useClip) {
    vec3 cUv = u_uvToClip * vec3(v_uv, 1.0);
    as *= texture(u_clip, cUv.xy).a; // clip to the alpha of the layer below
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
// Channel view (Photoshop-style). u_chMask is 1.0 for each ENABLED R,G,B,A.
// When all four are 1 the masking branch is a NO-OP (output byte-identical to
// the original present pass). With a single solo color channel we show it as
// grayscale; alpha-solo shows alpha as grayscale; multiple color channels show
// only those colors. Defaults to (1,1,1,1) so unset = normal rendering.
uniform vec4 u_chMask;

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
  float a = c.a;

  // ── channel view ──
  // No-op when all four channels are enabled (the common case).
  bool allOn = u_chMask.r > 0.5 && u_chMask.g > 0.5 && u_chMask.b > 0.5 && u_chMask.a > 0.5;
  if (!allOn) {
    float nRgb = u_chMask.r + u_chMask.g + u_chMask.b;
    if (nRgb < 0.5) {
      // No color channel: alpha-solo shows alpha as grayscale (opaque); if alpha
      // is also off, nothing is shown (black, opaque).
      float v = u_chMask.a > 0.5 ? c.a : 0.0;
      rgb = vec3(v);
      a = 1.0;
    } else if (nRgb < 1.5) {
      // Exactly one color channel: display it as grayscale (Photoshop default).
      float v = dot(rgb, u_chMask.rgb); // picks the single enabled channel
      rgb = vec3(v);
      a = 1.0;
    } else {
      // Two or three color channels: keep only the enabled colors; alpha follows
      // its own toggle (opaque when alpha is disabled).
      rgb *= u_chMask.rgb;
      a = u_chMask.a > 0.5 ? c.a : 1.0;
    }
  }

  // Checkerboard backdrop (in display space).
  vec2 px = gl_FragCoord.xy;
  vec2 cell = floor(px / u_checkSize);
  float checker = mod(cell.x + cell.y, 2.0);
  vec3 bg = mix(vec3(0.18), vec3(0.26), checker);

  // Composite straight color over backdrop using alpha.
  vec3 outLinear = mix(bg, rgb, clamp(a, 0.0, 1.0));
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
 * Brush dab with shape DYNAMICS: an elliptical (roundness) + rotated (angle)
 * soft tip, with an optional procedural-noise texture (chalk). Identical to
 * DAB_FRAG when roundness=1, angle=0, textured=false. Coverage is MAX-blended
 * into the wet buffer by the BrushEngine, so per-dab flow + falloff shape it.
 *
 * The dab quad is diameter×diameter; v_uv (0..1) -> local d (-1..1). We rotate d
 * by -angle into tip space, then squash the minor axis by 1/roundness so the
 * radial falloff becomes an ellipse oriented at `angle`.
 */
export const BRUSH_DAB_FRAG = /* glsl */ `#version 300 es
precision highp float;
in vec2 v_uv;
out vec4 fragColor;
uniform float u_hardness;
uniform float u_flow;
uniform float u_roundness;   // 0..1 (1 = circle)
uniform float u_angle;       // radians (tip rotation)
uniform bool u_textured;     // chalk-style noise-modulated alpha
uniform vec2 u_dabSeed;      // per-dab seed so texture varies between dabs
uniform sampler2D u_selection;
uniform bool u_useSelection;
uniform mat3 u_uvToSel;

// Cheap value noise (hash-based), enough for a chalky grain.
float hash(vec2 p) {
  p = fract(p * vec2(123.34, 456.21));
  p += dot(p, p + 45.32);
  return fract(p.x * p.y);
}
float valueNoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  float a = hash(i);
  float b = hash(i + vec2(1.0, 0.0));
  float c = hash(i + vec2(0.0, 1.0));
  float d = hash(i + vec2(1.0, 1.0));
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}

void main() {
  vec2 d = v_uv * 2.0 - 1.0;       // -1..1 in the quad
  // Rotate into tip space (rotate by -angle), then squash the minor axis.
  float ca = cos(-u_angle), sa = sin(-u_angle);
  vec2 rot = vec2(ca * d.x - sa * d.y, sa * d.x + ca * d.y);
  float round = clamp(u_roundness, 0.05, 1.0);
  rot.y /= round;                  // larger radius along the minor axis = ellipse
  float r = length(rot);
  if (r > 1.0) discard;
  float inner = clamp(u_hardness, 0.0, 0.98);
  float cov = 1.0 - smoothstep(inner, 1.0, r);
  cov *= u_flow;
  if (u_textured) {
    // Modulate by a couple of noise octaves so coverage breaks up like chalk.
    vec2 np = v_uv * 9.0 + u_dabSeed;
    float n = valueNoise(np) * 0.6 + valueNoise(np * 2.3) * 0.4;
    cov *= mix(0.35, 1.0, n);
  }
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

// ──────────────────────────────────────────────────────────────
// Layer styles / effects
//
// Effects are derived from a layer's ALPHA. The engine first extracts the
// layer's alpha into a single-channel (R8) buffer at the LAYER's footprint
// (EFFECT_ALPHA_FRAG, with optional choke for drop-shadow spread), separably
// blurs it (BLUR_FRAG) for shadow / glow, then composites the tinted result as a
// premultiplied-linear quad over the backdrop (EFFECT_FILL_FRAG). Stroke is
// computed from the un-blurred alpha by sampling a ring kernel
// (EFFECT_STROKE_FRAG). All colors are straight sRGB uniforms, decoded to
// linear in-shader; outputs are PREMULTIPLIED LINEAR (drawn with blend
// ONE, ONE_MINUS_SRC_ALPHA into the accumulator).
// ──────────────────────────────────────────────────────────────

/**
 * Composite a premultiplied-linear effect quad OVER the current accumulator in
 * the fragment shader (blend DISABLED), so it does not depend on hardware
 * blending into the float (RGBA16F) draw buffer — which is silently dropped on
 * drivers lacking EXT_float_blend (notably Chrome/ANGLE on macOS), the reason
 * layer effects rendered nothing.
 *
 * `u_src` is the effect's premultiplied-linear color (sampled by the quad's uv);
 * `u_backdrop` is the accumulator we are writing into, sampled by screen
 * position so fragments outside the effect quad still pass the backdrop through.
 * Output = src + backdrop * (1 - src.a)  (premultiplied source-over).
 */
export const EFFECT_OVER_FRAG = /* glsl */ `#version 300 es
precision highp float;
in vec2 v_uv;
out vec4 fragColor;
uniform sampler2D u_src;        // effect quad, premultiplied linear (quad uv)
uniform sampler2D u_backdrop;   // current accumulator, premultiplied linear
uniform vec2 u_backdropSize;    // accumulator size in px (for gl_FragCoord lookup)
void main() {
  vec4 src = texture(u_src, v_uv);
  vec4 bp = texture(u_backdrop, gl_FragCoord.xy / u_backdropSize);
  fragColor = src + bp * (1.0 - src.a);
}
`;

/**
 * Extract a layer texture's alpha into R. `u_choke` (0..1) thresholds the alpha
 * to thicken (spread) the shape before blurring (drop-shadow spread / glow).
 */
export const EFFECT_ALPHA_FRAG = /* glsl */ `#version 300 es
precision highp float;
in vec2 v_uv;
out vec4 fragColor;
uniform sampler2D u_tex;   // layer texture (alpha is straight in either encoding)
uniform float u_choke;     // 0..1 — push alpha toward 1 below the threshold
void main() {
  float a = texture(u_tex, v_uv).a;
  if (u_choke > 0.0) {
    // Remap so values above (1-choke) snap to 1 — a cheap spread.
    a = smoothstep(0.0, max(1e-3, 1.0 - u_choke), a);
  }
  fragColor = vec4(a, 0.0, 0.0, 1.0);
}
`;

/**
 * Composite a tinted alpha buffer (R) as a premultiplied-linear colored quad.
 * Used for drop shadow, outer glow and color overlay. `u_shapeMul` optionally
 * multiplies coverage by a second alpha buffer (the layer's own un-blurred
 * alpha) so color overlay is clipped to the shape; pass u_useShape=false for
 * shadow / glow (which extend beyond the shape).
 *
 * Output is premultiplied linear: rgb = colorLinear * cov, a = cov.
 */
export const EFFECT_FILL_FRAG = /* glsl */ `#version 300 es
precision highp float;
in vec2 v_uv;
out vec4 fragColor;
uniform sampler2D u_cov;     // coverage alpha (R) — blurred for shadow/glow
uniform sampler2D u_shape;   // layer alpha (R) for clipping color overlay
uniform bool u_useShape;
uniform vec3 u_color;        // straight sRGB
uniform float u_opacity;     // 0..1 master
vec3 srgbToLinear(vec3 c){return mix(c/12.92, pow((c+0.055)/1.055, vec3(2.4)), step(0.04045,c));}
void main() {
  float cov = texture(u_cov, v_uv).r * u_opacity;
  if (u_useShape) cov *= texture(u_shape, v_uv).r;
  vec3 lin = srgbToLinear(u_color);
  fragColor = vec4(lin * cov, cov);
}
`;

/**
 * Stroke from a layer's alpha. Samples a ring kernel of radius u_radius texels
 * and builds a band of width u_width around the alpha edge. `u_position`:
 *   0 outside  — band lies where alpha is ~0 but a neighbour within width is ~1
 *   1 inside   — band lies where alpha is ~1 but a neighbour within width is ~0
 *   2 center   — half outside / half inside
 * Output is premultiplied linear tinted by u_color * u_opacity.
 */
export const EFFECT_STROKE_FRAG = /* glsl */ `#version 300 es
precision highp float;
in vec2 v_uv;
out vec4 fragColor;
uniform sampler2D u_shape;   // layer alpha (R)
uniform vec2 u_texel;        // 1/footprint px
uniform float u_width;       // stroke width in texels
uniform int u_position;      // 0 outside, 1 inside, 2 center
uniform vec3 u_color;        // straight sRGB
uniform float u_opacity;
vec3 srgbToLinear(vec3 c){return mix(c/12.92, pow((c+0.055)/1.055, vec3(2.4)), step(0.04045,c));}
void main() {
  float a = texture(u_shape, v_uv).r;
  // Radius to search depends on position.
  float outR = (u_position == 1) ? 0.0 : u_width;
  float inR  = (u_position == 0) ? 0.0 : u_width;
  if (u_position == 2) { outR = u_width * 0.5; inR = u_width * 0.5; }
  int R = int(ceil(max(outR, inR)));
  float maxN = a;
  float minN = a;
  for (int dy = -32; dy <= 32; dy++) {
    if (dy < -R || dy > R) continue;
    for (int dx = -32; dx <= 32; dx++) {
      if (dx < -R || dx > R) continue;
      float d = length(vec2(float(dx), float(dy)));
      vec2 uv = v_uv + u_texel * vec2(float(dx), float(dy));
      float s = texture(u_shape, clamp(uv, vec2(0.0), vec2(1.0))).r;
      if (d <= outR) maxN = max(maxN, s);
      if (d <= inR)  minN = min(minN, s);
    }
  }
  // Outside band: currently transparent, but an opaque pixel is within outR.
  float outsideBand = (1.0 - a) * maxN;
  // Inside band: currently opaque, but a transparent pixel is within inR.
  float insideBand = a * (1.0 - minN);
  float band = 0.0;
  if (u_position == 0) band = outsideBand;
  else if (u_position == 1) band = insideBand;
  else band = max(outsideBand, insideBand);
  float cov = clamp(band, 0.0, 1.0) * u_opacity;
  vec3 lin = srgbToLinear(u_color);
  fragColor = vec4(lin * cov, cov);
}
`;

/**
 * Inner shadow: a shadow contained WITHIN the layer's alpha. Takes the layer's
 * alpha (u_shape) and a blurred INVERTED+offset alpha (u_cov), multiplies them
 * so it only shows over opaque pixels. Output premultiplied linear.
 */
export const EFFECT_INNER_FRAG = /* glsl */ `#version 300 es
precision highp float;
in vec2 v_uv;
out vec4 fragColor;
uniform sampler2D u_cov;     // blurred INVERTED alpha, offset (R)
uniform sampler2D u_shape;   // layer alpha (R)
uniform vec3 u_color;        // straight sRGB
uniform float u_opacity;
vec3 srgbToLinear(vec3 c){return mix(c/12.92, pow((c+0.055)/1.055, vec3(2.4)), step(0.04045,c));}
void main() {
  float cov = texture(u_cov, v_uv).r * texture(u_shape, v_uv).r * u_opacity;
  vec3 lin = srgbToLinear(u_color);
  fragColor = vec4(lin * cov, cov);
}
`;

/** Invert a single-channel alpha buffer with an offset sample (for inner shadow). */
export const EFFECT_INVERT_OFFSET_FRAG = /* glsl */ `#version 300 es
precision highp float;
in vec2 v_uv;
out vec4 fragColor;
uniform sampler2D u_src;     // alpha (R)
uniform vec2 u_offset;       // uv offset (so the inner shadow casts from a direction)
void main() {
  float a = texture(u_src, clamp(v_uv - u_offset, vec2(0.0), vec2(1.0))).r;
  fragColor = vec4(1.0 - a, 0.0, 0.0, 1.0);
}
`;

// ════════════════════════════════════════════════════════════
//  LIQUIFY (displacement-map warp on the active raster layer)
// ════════════════════════════════════════════════════════════
/**
 * The displacement map stores, per layer pixel, the offset (in LAYER PIXELS)
 * applied when sampling the layer: a fragment at layer uv `p` displays the layer
 * pixel at `p + disp(p)`. Identity = zero displacement. The RG channels hold the
 * x/y offset; B/A are unused (kept 0/1). It lives in an RGBA16F color target.
 *
 * Each Liquify dab is a read-modify-write of the whole map (blend DISABLED,
 * in-shader ping-pong — hardware float blend is silently dropped on Chrome/ANGLE
 * macOS). The shader reads the prior displacement, computes a brush-weighted
 * delta for the active mode, and writes the combined result. Brush falloff is a
 * smooth radial weight scaled by pressure.
 *
 *   mode 0 forward_warp : translate the displacement under the brush by -motion
 *                         (so the source the warped pixel samples follows the
 *                         pointer — pixels appear pushed in the drag direction).
 *   mode 1 bloat        : push displacement OUTWARD from the brush center (pixels
 *                         appear to expand) -> sample from inside => disp toward center.
 *   mode 2 pucker       : pull displacement INWARD (pixels contract).
 *   mode 3 twirl_left   : rotate displacement CCW around the center.
 *   mode 4 twirl_right  : rotate displacement CW around the center.
 *   mode 5 reconstruct  : relax the displacement back toward identity (zero).
 */
export const LIQUIFY_DAB_FRAG = /* glsl */ `#version 300 es
precision highp float;
in vec2 v_uv;                 // 0..1 over the displacement map (== layer uv)
out vec4 fragColor;

uniform sampler2D u_disp;     // prior displacement (RG = offset in layer px)
uniform vec2 u_size;          // layer/map size in px
uniform vec2 u_center;        // brush center in layer px
uniform float u_radius;       // brush radius in layer px
uniform vec2 u_motion;        // pointer motion vector (layer px) since last dab
uniform float u_strength;     // 0..1 effect strength (pressure * mode gain)
uniform int u_mode;           // see header
uniform sampler2D u_selection;
uniform bool u_useSelection;
uniform mat3 u_uvToSel;       // map uv -> selection uv

void main() {
  vec2 prior = texture(u_disp, v_uv).rg;
  vec2 px = v_uv * u_size;            // this fragment in layer px
  vec2 toC = px - u_center;           // vector from brush center to fragment
  float dist = length(toC);
  float r = max(u_radius, 1.0);
  // Smooth radial falloff (1 at center -> 0 at the rim).
  float w = 1.0 - smoothstep(0.0, r, dist);
  w *= u_strength;

  // Selection constrains where Liquify may act (mirrors the brush dab path).
  if (u_useSelection) {
    vec3 sUv = u_uvToSel * vec3(v_uv, 1.0);
    w *= texture(u_selection, clamp(sUv.xy, vec2(0.0), vec2(1.0))).r;
  }

  vec2 delta = vec2(0.0);
  if (u_mode == 0) {
    // forward warp (push): the displayed pixel should come from where the brush
    // just was, so add -motion weighted by falloff.
    delta = -u_motion * w;
  } else if (u_mode == 1) {
    // bloat: pixels expand outward => sample from nearer the center => disp
    // points toward the center.
    vec2 dir = dist > 1e-3 ? toC / dist : vec2(0.0);
    delta = -dir * (r * 0.5) * w;
  } else if (u_mode == 2) {
    // pucker: pixels contract => sample from farther out => disp points outward.
    vec2 dir = dist > 1e-3 ? toC / dist : vec2(0.0);
    delta = dir * (r * 0.5) * w;
  } else if (u_mode == 3 || u_mode == 4) {
    // twirl: rotate the SAMPLE coordinate around the center. A rotated sample
    // point s = center + R(theta)*toC; the displacement delta is (s - px).
    float sign = (u_mode == 3) ? 1.0 : -1.0; // left = CCW
    float theta = sign * w * 1.2;            // up to ~1.2 rad at full weight
    float ct = cos(theta), st = sin(theta);
    vec2 rotated = vec2(ct * toC.x - st * toC.y, st * toC.x + ct * toC.y);
    delta = rotated - toC;
  } else {
    // reconstruct: relax toward identity (pull the displacement toward 0).
    fragColor = vec4(mix(prior, vec2(0.0), clamp(w, 0.0, 1.0)), 0.0, 1.0);
    return;
  }

  fragColor = vec4(prior + delta, 0.0, 1.0);
}
`;

/**
 * Sample the layer THROUGH the displacement map for the live warped preview /
 * the final bake. `u_disp` holds per-pixel offsets in layer px; the displayed
 * layer uv is `v_uv + disp(v_uv) / size`. The layer texture is sRGB-decoding
 * (u_srgbLayer true) or RGBA8 verbatim. Output is premultiplied linear so it can
 * be composited OVER the backdrop like the brush preview (when u_premul) — for
 * the bake we instead re-encode straight sRGB (u_premul false).
 */
export const LIQUIFY_PREVIEW_FRAG = /* glsl */ `#version 300 es
precision highp float;
in vec2 v_uv;
out vec4 fragColor;
uniform sampler2D u_layer;
uniform sampler2D u_disp;
uniform vec2 u_size;
uniform bool u_srgbLayer;     // TRUE when the layer is an SRGB8_ALPHA8 sampler
                              // (texture() already returns LINEAR rgb).
uniform bool u_premul;        // true: premultiplied linear out; false: straight sRGB out

vec3 srgbToLinear(vec3 c) {
  return mix(c / 12.92, pow((c + 0.055) / 1.055, vec3(2.4)), step(0.04045, c));
}
vec3 linearToSrgb(vec3 c) {
  return mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(0.0031308, c));
}

void main() {
  vec2 disp = texture(u_disp, v_uv).rg;
  vec2 srcUv = v_uv + disp / u_size;
  // Outside the layer reads as transparent (so warps that pull from off-canvas
  // don't smear the edge texel across the gap).
  if (srcUv.x < 0.0 || srcUv.x > 1.0 || srcUv.y < 0.0 || srcUv.y > 1.0) {
    fragColor = vec4(0.0);
    return;
  }
  vec4 c = texture(u_layer, srcUv);
  // Resolve the sampled rgb to LINEAR: an SRGB8 sampler already decoded; an
  // RGBA8 sampler returned display-sRGB bytes that we decode here.
  vec3 lin = u_srgbLayer ? c.rgb : srgbToLinear(c.rgb);
  if (u_premul) {
    // Live preview: premultiplied LINEAR so it composites over the backdrop.
    fragColor = vec4(lin * c.a, c.a);
  } else {
    // Bake: straight-alpha DISPLAY-sRGB for the RGBA8 layer store.
    fragColor = vec4(linearToSrgb(lin), c.a);
  }
}
`;

/**
 * AI Lens Blur — depth-aware BOKEH blur.
 *
 * A single-pass disc-scatter blur whose per-pixel radius is driven by the
 * estimated depth map: pixels at the in-focus depth stay sharp; pixels whose
 * normalized depth differs from `u_focus` get blurred by up to `u_maxRadius`
 * texels (scaled by |depth - focus|). The accumulation is done in LINEAR light
 * with a highlight boost so bright out-of-focus points bloom into round bokeh
 * discs (the hallmark of a real lens), then re-encoded.
 *
 * Convention: depth texture R channel is 0..1 with NEAR = 1 (bright), FAR = 0
 * (matching depthClient). `u_focus` 0..1 is the in-focus depth on that scale.
 *
 * Encoding mirrors the destructive-filter convention (F_HEADER): pass reads the
 * layer texture (u_decodeSrc=true → SRGB8 sampler already decoded to linear, so
 * we keep linear) or an RGBA8 display-sRGB byte texture (u_decodeSrc=false →
 * decode here), accumulates in linear, and writes straight-alpha DISPLAY-sRGB.
 */
export const LENS_BLUR_FRAG = /* glsl */ `#version 300 es
precision highp float;
in vec2 v_uv;
out vec4 fragColor;
uniform sampler2D u_src;     // layer / previous-pass color
uniform sampler2D u_depth;   // R8 depth, near = 1
uniform vec2  u_texel;       // 1/width, 1/height
uniform bool  u_decodeSrc;   // true when u_src is an SRGB8 sampler (linear out)
uniform float u_focus;       // in-focus depth 0..1 (near = 1)
uniform float u_maxRadius;   // max blur radius in texels
uniform float u_bokeh;       // highlight bloom strength 0..1

vec3 srgbToLinear(vec3 c){return mix(c/12.92, pow((c+0.055)/1.055, vec3(2.4)), step(0.04045,c));}
vec3 linearToSrgb(vec3 c){return mix(c*12.92, 1.055*pow(c, vec3(1.0/2.4))-0.055, step(0.0031308,c));}

// Resolve a sampled texel to LINEAR straight-alpha rgb.
vec4 srcLinear(vec2 uv){
  vec4 c = texture(u_src, uv);
  vec3 lin = u_decodeSrc ? c.rgb : srgbToLinear(c.rgb);
  return vec4(lin, c.a);
}

void main(){
  float centerDepth = texture(u_depth, v_uv).r;
  // Circle of confusion: how far this pixel is from the focal plane.
  float coc = abs(centerDepth - u_focus);
  float radius = coc * u_maxRadius;

  vec4 center = srcLinear(v_uv);
  if (radius < 0.75) {
    // Sharp: pass through unchanged (re-encode to display sRGB straight).
    fragColor = vec4(linearToSrgb(center.rgb), center.a);
    return;
  }

  // Disc scatter over a fixed sample budget on a sunflower (golden-angle)
  // spiral — even coverage without banding. Highlights (bright linear values)
  // are weighted up so they bloom into bokeh discs.
  const int SAMPLES = 48;
  const float GOLDEN = 2.39996323;
  vec3 accum = vec3(0.0);
  float aAccum = 0.0;
  float wsum = 0.0;
  for (int i = 0; i < SAMPLES; i++){
    float fi = float(i);
    float r = sqrt((fi + 0.5) / float(SAMPLES)) * radius;
    float ang = fi * GOLDEN;
    vec2 off = vec2(cos(ang), sin(ang)) * r * u_texel;
    vec2 uv = v_uv + off;
    vec4 s = srcLinear(uv);
    // Depth-respecting gather: only let samples that are NOT sharply in front
    // contribute, so a focused foreground edge doesn't bleed onto a blurred
    // background. Samples nearer the camera than the center by a lot are
    // down-weighted (prevents focused subject leaking outwards).
    float sDepth = texture(u_depth, uv).r;
    float occl = 1.0 - clamp((sDepth - centerDepth) * 4.0, 0.0, 1.0);
    float lum = dot(s.rgb, vec3(0.2126, 0.7152, 0.0722));
    float hl = 1.0 + u_bokeh * 6.0 * smoothstep(0.6, 1.0, lum);
    float w = s.a * occl * hl;
    accum += s.rgb * w;
    aAccum += s.a * occl;
    wsum += w;
  }
  vec3 outRgb = wsum > 0.0 ? accum / wsum : center.rgb;
  float outA = float(SAMPLES) > 0.0 ? aAccum / float(SAMPLES) : center.a;
  // Keep the original coverage near opaque centers stable.
  outA = mix(center.a, outA, clamp(radius / max(u_maxRadius, 1.0), 0.0, 1.0));
  fragColor = vec4(linearToSrgb(outRgb), outA);
}
`;

/**
 * SAM candidate overlay — samples an R8 mask (the live SAM candidate) and draws
 * a translucent tint where the mask is set, plus a crisp 1px edge band so the
 * candidate reads clearly over the image before it is committed. Drawn over the
 * present pass into the (RGBA8) default framebuffer with hardware alpha blend.
 */
export const MASK_TINT_FRAG = /* glsl */ `#version 300 es
precision highp float;
in vec2 v_uv;
out vec4 fragColor;
uniform sampler2D u_mask;   // R8 candidate (row 0 = layer/doc top)
uniform vec2 u_texel;       // 1/maskW, 1/maskH
uniform vec3 u_tint;        // overlay color (straight sRGB; FBO is sRGB-encoded)
void main(){
  float m = texture(u_mask, v_uv).r;
  // Edge detect via 4-neighbour gradient for a brighter rim.
  float l = texture(u_mask, v_uv + vec2(-u_texel.x, 0.0)).r;
  float r = texture(u_mask, v_uv + vec2( u_texel.x, 0.0)).r;
  float u = texture(u_mask, v_uv + vec2(0.0, -u_texel.y)).r;
  float d = texture(u_mask, v_uv + vec2(0.0,  u_texel.y)).r;
  float edge = clamp(abs(m - l) + abs(m - r) + abs(m - u) + abs(m - d), 0.0, 1.0);
  float fill = m * 0.4;
  float a = max(fill, edge * 0.9);
  fragColor = vec4(u_tint, a);
}
`;

/**
 * Depth-map visualization blit — samples the R8 depth texture and writes it as
 * a grayscale RGBA8 (near = bright). Used by getDepthPreview() / a "view depth"
 * affordance. The fullscreen quad samples v_uv directly (no Y flip).
 */
export const DEPTH_VIEW_FRAG = /* glsl */ `#version 300 es
precision highp float;
in vec2 v_uv;
out vec4 fragColor;
uniform sampler2D u_depth;
void main(){
  float d = texture(u_depth, v_uv).r;
  fragColor = vec4(d, d, d, 1.0);
}
`;
