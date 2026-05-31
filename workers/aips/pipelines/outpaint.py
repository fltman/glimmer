"""Outpaint pipeline — extend the canvas beyond the original frame.

The model still has no native outpaint endpoint, so we synthesize it the same
way as inpaint:

  1. Expand the canvas by the per-side margins and inset the original into a
     neutral (mid-gray) frame, with a feathered seam band so the model has a soft
     gradient to extend into rather than a hard edge.
  2. Build a (image + mask) edit request: the mask marks the NEW border region as
     editable and the inset as locked. The instruction tells the model to extend
     the scene naturally without altering the inset.
  3. Re-align the output to the full expanded grid (never trust output size).
  4. Color/exposure-match against the KNOWN inset pixels (the trusted region).
  5. Feather across the seam and composite so the original inset stays exact.

Returns the full-size composited PNG and its placement in the document (offset by
the left/top expansion so the original content stays put).
"""

from __future__ import annotations

from dataclasses import dataclass

from PIL import Image

from ..providers.openrouter import ImageResult, OpenRouterImageProvider
from . import imaging


@dataclass
class OutpaintResult:
    png_bytes: bytes
    width: int
    height: int
    placement_roi: dict
    cost_usd: float | None
    model: str


def _build_instruction(prompt: str | None) -> str:
    base = (
        "You are extending the FIRST image onto a larger canvas. The SECOND image "
        "is a mask: white marks the NEW border area you must paint; black marks the "
        "original photo, which must remain byte-for-byte identical. Continue the "
        "scene naturally outward — matching perspective, lighting, color and texture "
        "at the seam. Do not add a frame, border or vignette, and do not alter, "
        "shift or resize the original (black) region."
    )
    p = (prompt or "").strip()
    if p:
        return f"{base} The newly revealed area should depict: {p}."
    return base


def run_outpaint(
    *,
    image_bytes: bytes,
    expand: dict,
    prompt: str | None,
    seed: int | None,
    provider: OpenRouterImageProvider | None = None,
) -> OutpaintResult:
    """Execute the outpaint pipeline and return the full expanded image."""
    provider = provider or OpenRouterImageProvider()

    src = imaging.decode_rgba(image_bytes)
    top = max(0, int(expand.get("top", 0)))
    right = max(0, int(expand.get("right", 0)))
    bottom = max(0, int(expand.get("bottom", 0)))
    left = max(0, int(expand.get("left", 0)))

    new_w = src.width + left + right
    new_h = src.height + top + bottom

    # 1) inset the original into a neutral mid-gray frame (a calm base the model
    # can paint over without fighting a colored background).
    canvas = Image.new("RGBA", (new_w, new_h), (128, 128, 128, 255))
    canvas.paste(src, (left, top))

    # Mask: white = new border (editable), black = original inset (locked).
    mask = Image.new("L", (new_w, new_h), 255)
    inset_mask = Image.new("L", src.size, 0)
    mask.paste(inset_mask, (left, top))

    # Feathered seam band: soften the inset edge a few px inward so the blend
    # ramps over real pixels at the join (avoids a hard outline).
    seam = imaging.feather_mask(mask, erode_px=0, blur_px=4.0)

    # 2) creative step
    instruction = _build_instruction(prompt)
    edit_result: ImageResult = provider.image_edit_with_mask(
        image_bytes=imaging.encode_png(canvas),
        mask_bytes=imaging.encode_png(mask.convert("RGBA")),
        instruction=instruction,
        seed=seed,
    )

    # 3) re-align to the full expanded grid.
    result_img = imaging.resize_to(imaging.decode_rgba(edit_result.png_bytes), (new_w, new_h))

    # 4) color-match using ONLY the known inset pixels (black in `mask`).
    unmasked = Image.eval(mask, lambda v: 255 - v)  # 255 over the trusted inset
    matched = imaging.color_match(result_img, canvas, unmasked)

    # 5) composite: keep the original inset exact, take the model's border, and
    # let the feathered seam blend the join.
    composited = imaging.blend_masked(canvas, matched, seam)
    # Re-stamp the pristine original on top to guarantee the inset is untouched
    # (the seam feather only blends a thin band just outside it).
    hard_inset_mask = Image.new("L", (new_w, new_h), 0)
    hard_inset_mask.paste(Image.new("L", src.size, 255), (left, top))
    eroded = imaging.feather_mask(hard_inset_mask, erode_px=4, blur_px=2.0)
    composited = imaging.blend_masked(composited, canvas, eroded)

    png = imaging.encode_png(composited)
    return OutpaintResult(
        png_bytes=png,
        width=composited.width,
        height=composited.height,
        # Placement: the expanded image's top-left sits `left`/`top` to the
        # upper-left of the original content's old origin.
        placement_roi={"x": -left, "y": -top, "width": new_w, "height": new_h},
        cost_usd=edit_result.cost_usd,
        model=edit_result.model,
    )
