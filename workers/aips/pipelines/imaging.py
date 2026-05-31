"""Shared imaging primitives for the inpaint/outpaint pipelines.

All functions operate on Pillow images (RGBA) and/or numpy float arrays. They are
deliberately provider-agnostic — the pipelines call a provider for the creative
step, then use these to re-align, color-match, feather and composite the result
so the untouched pixels stay byte-stable and the edited region blends seamlessly.
"""

from __future__ import annotations

from io import BytesIO

import numpy as np
from PIL import Image, ImageFilter


def decode_rgba(data: bytes) -> Image.Image:
    """Decode arbitrary image bytes to an RGBA Pillow image."""
    return Image.open(BytesIO(data)).convert("RGBA")


def decode_mask_l(data: bytes, size: tuple[int, int]) -> Image.Image:
    """Decode a mask to single-channel L, resized to `size` (white = act here)."""
    m = Image.open(BytesIO(data)).convert("L")
    if m.size != size:
        m = m.resize(size, Image.LANCZOS)
    return m


def encode_png(img: Image.Image) -> bytes:
    buf = BytesIO()
    img.save(buf, format="PNG")
    return buf.getvalue()


def resize_to(img: Image.Image, size: tuple[int, int]) -> Image.Image:
    """Re-align a model output to the exact target pixel grid (never trust output
    size — Gemini-style models routinely return a different resolution)."""
    if img.size != size:
        return img.resize(size, Image.LANCZOS)
    return img


def feather_mask(mask: Image.Image, *, erode_px: int = 2, blur_px: float = 3.0) -> Image.Image:
    """Slightly erode then Gaussian-blur a binary-ish mask into a soft alpha.

    Eroding first pulls the blend boundary just inside the masked region so the
    feather ramps over original pixels at the seam (avoids a hard halo).
    """
    m = mask
    if erode_px > 0:
        # MinFilter shrinks white regions; kernel must be odd.
        k = max(3, erode_px * 2 + 1)
        m = m.filter(ImageFilter.MinFilter(k))
    if blur_px > 0:
        m = m.filter(ImageFilter.GaussianBlur(radius=blur_px))
    return m


def _fit_gain_offset(src: np.ndarray, ref: np.ndarray, weights: np.ndarray) -> tuple[float, float]:
    """Weighted least-squares fit of ref ≈ gain*src + offset on one channel.

    `weights` (same shape) restricts the fit to trusted (unmasked) pixels.
    Returns (gain, offset); falls back to identity when the system is degenerate.
    """
    w = weights
    sw = float(w.sum())
    if sw < 1.0:
        return 1.0, 0.0
    sx = float((w * src).sum())
    sy = float((w * ref).sum())
    sxx = float((w * src * src).sum())
    sxy = float((w * src * ref).sum())
    denom = sw * sxx - sx * sx
    if abs(denom) < 1e-6:
        # Degenerate: the source channel is ~constant over the trusted region
        # (e.g. flat sky), so gain is unidentifiable — correct with a pure offset
        # (match the means) instead of falling back to identity, which would
        # leave a uniform color shift uncorrected.
        offset = (sy - sx) / sw
        return 1.0, float(np.clip(offset, -64.0, 64.0))
    gain = (sw * sxy - sx * sy) / denom
    offset = (sy - gain * sx) / sw
    # Clamp to sane ranges so a bad fit can't blow up the image.
    gain = float(np.clip(gain, 0.5, 2.0))
    offset = float(np.clip(offset, -64.0, 64.0))
    return gain, offset


def color_match(
    result: Image.Image,
    original: Image.Image,
    unmasked_alpha: Image.Image,
) -> Image.Image:
    """Per-channel gain+offset matching of `result` to `original`.

    Fits the linear correction ONLY over the unmasked (trusted) region — where
    both images depict the same content — then applies it to the whole result.
    This kills the #1 inpaint artifact: a global color/exposure shift between the
    model's output and the surrounding pixels.

    `unmasked_alpha` is an L image where 255 = trusted/untouched pixel.
    """
    res = np.asarray(result.convert("RGB"), dtype=np.float64)
    ref = np.asarray(original.convert("RGB"), dtype=np.float64)
    w = np.asarray(unmasked_alpha, dtype=np.float64) / 255.0  # (H, W)

    out = np.empty_like(res)
    for c in range(3):
        gain, offset = _fit_gain_offset(res[..., c], ref[..., c], w)
        out[..., c] = res[..., c] * gain + offset

    out = np.clip(out, 0, 255).astype(np.uint8)
    matched = Image.fromarray(out, mode="RGB").convert("RGBA")
    # Preserve the result's own alpha channel.
    matched.putalpha(result.split()[-1])
    return matched


def blend_masked(
    original: Image.Image,
    result: Image.Image,
    alpha_mask: Image.Image,
) -> Image.Image:
    """out = original*(1-a) + result*a, where a is the feathered mask in [0,1].

    Only the masked region is taken from `result`; everything else stays exactly
    the original pixels. Operates in RGBA float space.
    """
    orig = np.asarray(original.convert("RGBA"), dtype=np.float64)
    res = np.asarray(result.convert("RGBA"), dtype=np.float64)
    a = (np.asarray(alpha_mask, dtype=np.float64) / 255.0)[..., None]  # (H, W, 1)

    out = orig * (1.0 - a) + res * a
    out = np.clip(out, 0, 255).astype(np.uint8)
    return Image.fromarray(out, mode="RGBA")


def composite_over(foreground: Image.Image, background: Image.Image) -> Image.Image:
    """Alpha-composite an RGBA `foreground` over `background` (background opaque).

    Resizes the foreground to the background grid if they differ. Returns an RGBA
    image (fully opaque) suitable for sending to an img2img model.
    """
    bg = background.convert("RGBA")
    fg = foreground.convert("RGBA")
    if fg.size != bg.size:
        fg = fg.resize(bg.size, Image.LANCZOS)
    return Image.alpha_composite(bg, fg)


def alpha_channel(img: Image.Image) -> Image.Image:
    """Return the alpha channel of an image as a single-channel L image."""
    return img.convert("RGBA").split()[-1]


# ──────────────────────────────────────────────────────────────
# CIE Lab color-grade transfer (Reinhard) — pure numpy, no skimage/cv2
# ──────────────────────────────────────────────────────────────

# sRGB <-> linear and linear-RGB <-> XYZ (D65) constants.
_RGB_TO_XYZ = np.array(
    [
        [0.4124564, 0.3575761, 0.1804375],
        [0.2126729, 0.7151522, 0.0721750],
        [0.0193339, 0.1191920, 0.9503041],
    ],
    dtype=np.float64,
)
_XYZ_TO_RGB = np.linalg.inv(_RGB_TO_XYZ)
# D65 reference white.
_WHITE_XYZ = np.array([0.95047, 1.0, 1.08883], dtype=np.float64)


def _srgb_to_linear(c: np.ndarray) -> np.ndarray:
    """sRGB [0,1] -> linear RGB."""
    return np.where(c <= 0.04045, c / 12.92, ((c + 0.055) / 1.055) ** 2.4)


def _linear_to_srgb(c: np.ndarray) -> np.ndarray:
    """Linear RGB -> sRGB [0,1]."""
    return np.where(c <= 0.0031308, c * 12.92, 1.055 * np.power(np.clip(c, 0, None), 1 / 2.4) - 0.055)


def _f_lab(t: np.ndarray) -> np.ndarray:
    delta = 6.0 / 29.0
    return np.where(t > delta**3, np.cbrt(t), t / (3 * delta**2) + 4.0 / 29.0)


def _f_lab_inv(t: np.ndarray) -> np.ndarray:
    delta = 6.0 / 29.0
    return np.where(t > delta, t**3, 3 * delta**2 * (t - 4.0 / 29.0))


def rgb_to_lab(rgb: np.ndarray) -> np.ndarray:
    """Convert an (H,W,3) uint8 (or [0,255] float) RGB array to CIE L*a*b*."""
    c = np.asarray(rgb, dtype=np.float64) / 255.0
    lin = _srgb_to_linear(c)
    xyz = lin @ _RGB_TO_XYZ.T
    xyz_n = xyz / _WHITE_XYZ
    f = _f_lab(xyz_n)
    fx, fy, fz = f[..., 0], f[..., 1], f[..., 2]
    lab = np.empty_like(xyz)
    lab[..., 0] = 116.0 * fy - 16.0  # L*  in [0,100]
    lab[..., 1] = 500.0 * (fx - fy)  # a*
    lab[..., 2] = 200.0 * (fy - fz)  # b*
    return lab


def lab_to_rgb(lab: np.ndarray) -> np.ndarray:
    """Convert an (H,W,3) CIE L*a*b* array back to uint8 RGB (clamped)."""
    lab = np.asarray(lab, dtype=np.float64)
    fy = (lab[..., 0] + 16.0) / 116.0
    fx = fy + lab[..., 1] / 500.0
    fz = fy - lab[..., 2] / 200.0
    xyz = np.stack(
        [_f_lab_inv(fx), _f_lab_inv(fy), _f_lab_inv(fz)], axis=-1
    ) * _WHITE_XYZ
    lin = xyz @ _XYZ_TO_RGB.T
    srgb = _linear_to_srgb(lin)
    return np.clip(srgb * 255.0, 0, 255).astype(np.uint8)


def lab_color_transfer(
    image: Image.Image,
    reference: Image.Image,
    strength: float = 1.0,
) -> Image.Image:
    """Reinhard mean/std color-grade transfer from `reference` onto `image`.

    Pure numpy/Pillow (no skimage/cv2). Works in CIE L*a*b*: each channel of the
    image is shifted/scaled so its per-channel mean and standard deviation match
    the reference's, then blended toward the original by `strength`
    (0 = original unchanged, 1 = full transfer). The image's alpha channel is
    preserved untouched. Reference alpha (if any) is ignored — all reference
    pixels contribute to its statistics.
    """
    s = float(max(0.0, min(1.0, strength)))
    src_rgba = image.convert("RGBA")
    alpha = src_rgba.split()[-1]

    src_rgb = np.asarray(src_rgba.convert("RGB"), dtype=np.float64)
    ref_rgb = np.asarray(reference.convert("RGB"), dtype=np.float64)

    src_lab = rgb_to_lab(src_rgb)
    ref_lab = rgb_to_lab(ref_rgb)

    src_mean = src_lab.reshape(-1, 3).mean(axis=0)
    src_std = src_lab.reshape(-1, 3).std(axis=0)
    ref_mean = ref_lab.reshape(-1, 3).mean(axis=0)
    ref_std = ref_lab.reshape(-1, 3).std(axis=0)

    # Guard against a flat (zero-variance) source channel.
    safe_std = np.where(src_std < 1e-6, 1.0, src_std)
    scale = ref_std / safe_std

    matched_lab = (src_lab - src_mean) * scale + ref_mean
    matched_rgb = lab_to_rgb(matched_lab).astype(np.float64)

    # Blend the fully-matched result back toward the original by (1 - strength).
    out_rgb = np.clip(src_rgb * (1.0 - s) + matched_rgb * s, 0, 255).astype(np.uint8)

    out = Image.fromarray(out_rgb, mode="RGB").convert("RGBA")
    out.putalpha(alpha)
    return out


def clamp_roi(
    roi: dict, img_w: int, img_h: int, pad_frac: float = 0.30
) -> tuple[int, int, int, int]:
    """Expand an ROI rect by `pad_frac` of its size and clamp to image bounds.

    Returns (left, top, right, bottom) suitable for Image.crop. Padding gives the
    model surrounding context so it can reconstruct/extend plausibly.
    """
    x = int(roi.get("x", 0))
    y = int(roi.get("y", 0))
    w = int(roi.get("width", img_w))
    h = int(roi.get("height", img_h))
    pad_x = int(round(w * pad_frac))
    pad_y = int(round(h * pad_frac))
    left = max(0, x - pad_x)
    top = max(0, y - pad_y)
    right = min(img_w, x + w + pad_x)
    bottom = min(img_h, y + h + pad_y)
    return left, top, right, bottom
