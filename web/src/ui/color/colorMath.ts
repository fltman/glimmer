/**
 * Color math helpers for the color UI.
 *
 * The authoritative color type is `RGBAColor` (sRGB straight, components 0..1)
 * from the tool store. These helpers convert between that and the
 * representations the picker needs to render and accept input:
 *   - HSV (h 0..360, s/v 0..1) for the SV square + hue strip,
 *   - 8-bit RGB (0..255) for the numeric inputs,
 *   - HEX (#rrggbb) for the text input.
 *
 * All math stays in the sRGB display domain — the engine handles the linear
 * conversion when it actually paints. Nothing here touches pixels.
 */
import type { RGBAColor } from "../../state/tools";

export interface HSV {
  /** Hue in degrees, 0..360. */
  h: number;
  /** Saturation 0..1. */
  s: number;
  /** Value 0..1. */
  v: number;
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

/** Convert straight sRGB 0..1 to HSV. */
export function rgbToHsv(c: RGBAColor): HSV {
  const r = clamp01(c.r);
  const g = clamp01(c.g);
  const b = clamp01(c.b);
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const d = max - min;

  let h = 0;
  if (d !== 0) {
    if (max === r) h = ((g - b) / d) % 6;
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h *= 60;
    if (h < 0) h += 360;
  }
  const s = max === 0 ? 0 : d / max;
  return { h, s, v: max };
}

/** Convert HSV to straight sRGB 0..1 (alpha carried through by the caller). */
export function hsvToRgb(hsv: HSV, a = 1): RGBAColor {
  const h = ((hsv.h % 360) + 360) % 360;
  const s = clamp01(hsv.s);
  const v = clamp01(hsv.v);

  const c = v * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = v - c;

  let r = 0;
  let g = 0;
  let b = 0;
  if (h < 60) [r, g, b] = [c, x, 0];
  else if (h < 120) [r, g, b] = [x, c, 0];
  else if (h < 180) [r, g, b] = [0, c, x];
  else if (h < 240) [r, g, b] = [0, x, c];
  else if (h < 300) [r, g, b] = [x, 0, c];
  else [r, g, b] = [c, 0, x];

  return { r: r + m, g: g + m, b: b + m, a: clamp01(a) };
}

function to255(v: number): number {
  return Math.round(clamp01(v) * 255);
}
function hex2(v: number): string {
  return to255(v).toString(16).padStart(2, "0");
}

/** "#rrggbb" (no alpha) for the hex input. */
export function rgbToHex(c: RGBAColor): string {
  return `#${hex2(c.r)}${hex2(c.g)}${hex2(c.b)}`;
}

/** "rgba(r,g,b,a)" for swatch backgrounds (a as 0..1, two decimals). */
export function rgbaCss(c: RGBAColor): string {
  return `rgba(${to255(c.r)}, ${to255(c.g)}, ${to255(c.b)}, ${clamp01(c.a).toFixed(2)})`;
}

/** Opaque "rgb(r,g,b)" — used where alpha must be ignored (e.g. SV/hue UI). */
export function rgbCss(c: RGBAColor): string {
  return `rgb(${to255(c.r)}, ${to255(c.g)}, ${to255(c.b)})`;
}

/**
 * Parse a hex string ("#abc", "#aabbcc", with/without "#") to straight sRGB.
 * Returns null on anything unparseable so callers can keep the prior color.
 * Alpha is preserved by the caller (hex inputs here are RGB-only).
 */
export function hexToRgb(hex: string, a = 1): RGBAColor | null {
  let s = hex.trim().replace(/^#/, "");
  if (s.length === 3) {
    const r = s[0];
    const g = s[1];
    const b = s[2];
    if (r === undefined || g === undefined || b === undefined) return null;
    s = `${r}${r}${g}${g}${b}${b}`;
  }
  if (s.length !== 6 || /[^0-9a-fA-F]/.test(s)) return null;
  const n = parseInt(s, 16);
  if (Number.isNaN(n)) return null;
  return {
    r: ((n >> 16) & 0xff) / 255,
    g: ((n >> 8) & 0xff) / 255,
    b: (n & 0xff) / 255,
    a: clamp01(a),
  };
}

/** 0..255 component triplet for the numeric RGB inputs. */
export function rgb255(c: RGBAColor): { r: number; g: number; b: number } {
  return { r: to255(c.r), g: to255(c.g), b: to255(c.b) };
}

/** Relative luminance (sRGB-weighted, no gamma) — for picking a readable label. */
export function perceivedLuminance(c: RGBAColor): number {
  return 0.299 * c.r + 0.587 * c.g + 0.114 * c.b;
}

export { clamp01 };
