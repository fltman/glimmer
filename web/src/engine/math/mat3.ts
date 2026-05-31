/**
 * Minimal column-major 3x3 matrix helpers for 2D affine transforms.
 *
 * Layout (column-major, matches GLSL `mat3` upload order):
 *   m = [ a, b, 0,   c, d, 0,   tx, ty, 1 ]
 * representing
 *   | a c tx |
 *   | b d ty |
 *   | 0 0  1 |
 *
 * Points are column vectors transformed as m * [x, y, 1].
 */
export type Mat3 = Float32Array;

export function identity(): Mat3 {
  return new Float32Array([1, 0, 0, 0, 1, 0, 0, 0, 1]);
}

/** out = a * b  (apply b first, then a). */
export function multiply(a: Mat3, b: Mat3): Mat3 {
  const out = new Float32Array(9);
  for (let col = 0; col < 3; col++) {
    for (let row = 0; row < 3; row++) {
      out[col * 3 + row] =
        a[0 * 3 + row]! * b[col * 3 + 0]! +
        a[1 * 3 + row]! * b[col * 3 + 1]! +
        a[2 * 3 + row]! * b[col * 3 + 2]!;
    }
  }
  return out;
}

export function translation(tx: number, ty: number): Mat3 {
  return new Float32Array([1, 0, 0, 0, 1, 0, tx, ty, 1]);
}

export function scaling(sx: number, sy: number): Mat3 {
  return new Float32Array([sx, 0, 0, 0, sy, 0, 0, 0, 1]);
}

/** Post-multiply m by a translation (translate in m's local space). */
export function translate(m: Mat3, tx: number, ty: number): Mat3 {
  return multiply(m, translation(tx, ty));
}

/** Post-multiply m by a scale. */
export function scale(m: Mat3, sx: number, sy: number): Mat3 {
  return multiply(m, scaling(sx, sy));
}

/** Invert an affine 3x3 (assumes last row is [0,0,1]; falls back to identity if singular). */
export function invert(m: Mat3): Mat3 {
  const a = m[0]!,
    b = m[1]!,
    c = m[3]!,
    d = m[4]!,
    tx = m[6]!,
    ty = m[7]!;
  const det = a * d - b * c;
  if (Math.abs(det) < 1e-12) return identity();
  const id = 1 / det;
  const ia = d * id;
  const ib = -b * id;
  const ic = -c * id;
  const idd = a * id;
  const itx = -(ia * tx + ic * ty);
  const ity = -(ib * tx + idd * ty);
  return new Float32Array([ia, ib, 0, ic, idd, 0, itx, ity, 1]);
}

/** Transform a 2D point by an affine matrix. */
export function transformPoint(
  m: Mat3,
  x: number,
  y: number,
): { x: number; y: number } {
  return {
    x: m[0]! * x + m[3]! * y + m[6]!,
    y: m[1]! * x + m[4]! * y + m[7]!,
  };
}

/**
 * Build a matrix mapping document/pixel space (origin top-left, +y down) to
 * clip space [-1,1] for a given drawing-buffer size. Combine with the view
 * transform before upload.
 */
export function pixelToClip(bufW: number, bufH: number): Mat3 {
  // x: [0,bufW] -> [-1,1] ; y: [0,bufH] -> [1,-1] (flip so +y is down on screen)
  return new Float32Array([2 / bufW, 0, 0, 0, -2 / bufH, 0, -1, 1, 1]);
}
