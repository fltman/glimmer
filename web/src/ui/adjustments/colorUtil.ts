/**
 * Tiny sRGB-straight <-> hex helpers for the adjustment color ParamFields.
 * Colors throughout the engine are sRGB STRAIGHT, components 0..1, so the only
 * job here is converting to/from the `#rrggbb` an <input type="color"> wants.
 */

export interface RGBA {
  r: number;
  g: number;
  b: number;
  a: number;
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

function toHexByte(v: number): string {
  const b = Math.round(clamp01(v) * 255);
  return b.toString(16).padStart(2, "0");
}

/** sRGB-straight color (0..1) -> "#rrggbb" (alpha dropped — the picker has none). */
export function rgbaToHex(c: RGBA): string {
  return `#${toHexByte(c.r)}${toHexByte(c.g)}${toHexByte(c.b)}`;
}

/** "#rrggbb" -> sRGB-straight color (0..1), preserving an existing alpha. */
export function hexToRgba(hex: string, alpha = 1): RGBA {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return { r: 0, g: 0, b: 0, a: alpha };
  const n = parseInt(m[1]!, 16);
  return {
    r: ((n >> 16) & 0xff) / 255,
    g: ((n >> 8) & 0xff) / 255,
    b: (n & 0xff) / 255,
    a: alpha,
  };
}

/** A CSS color string for swatches/previews (sRGB straight 0..1 -> rgba()). */
export function rgbaToCss(c: RGBA): string {
  const r = Math.round(clamp01(c.r) * 255);
  const g = Math.round(clamp01(c.g) * 255);
  const b = Math.round(clamp01(c.b) * 255);
  return `rgba(${r}, ${g}, ${b}, ${clamp01(c.a)})`;
}
