"""Inpaint pipeline — mask-aware edit synthesized on top of a mask-less model.

The OpenRouter image model (Gemini) has NO mask-in endpoint. We synthesize
masked editing:

  1. Resolve the ROI. The web client normally sends the padded-ROI crop + a mask
     of the same size, with `roi` giving its placement in the document. But we
     also support a full image being sent (image dims != roi dims) by cropping to
     the ROI plus ~30% padding, clamped to bounds.
  2. Build a single (image + strong instruction) edit request that names the
     masked region and forbids recomposition/resize. `fill` uses the prompt;
     `remove` reconstructs the background.
  3. Re-align the model output to the exact ROI pixel grid (never trust the
     returned resolution).
  4. Color/exposure-match the output to the original using ONLY the unmasked
     region (linear per-channel gain+offset) — kills global color shift.
  5. Feather the mask and composite: out = orig*(1-a) + matched*a, inside mask.

Returns the composited ROI-sized PNG plus the placement rect to drop it back
into the document as a new layer.
"""

from __future__ import annotations

from dataclasses import dataclass

from PIL import Image

from ..providers.openrouter import ImageResult, OpenRouterImageProvider
from . import imaging


@dataclass
class InpaintResult:
    png_bytes: bytes
    width: int
    height: int
    #: Where the composited ROI goes in the document.
    placement_roi: dict
    cost_usd: float | None
    model: str


def _build_instruction(mode: str, prompt: str) -> str:
    """Name the masked region explicitly and lock everything else down.

    A reference (white) mask is part of the request so the model knows exactly
    which pixels to touch; the prose still spells out the constraint because
    these models follow text more reliably than they respect a mask channel.
    """
    base = (
        "You are editing the FIRST image. The SECOND image is a mask: pure white "
        "marks the ONLY region you may change; black pixels must stay byte-for-byte "
        "identical. Do not recompose, crop, rotate or resize. Keep the framing, "
        "perspective, lighting, colors and exposure of the unmasked area identical."
    )
    if mode == "remove":
        return (
            f"{base} Task: REMOVE whatever object occupies the white region and "
            "plausibly reconstruct the background that would be behind it, matching "
            "surrounding texture, lighting and color."
        )
    # mode == "fill" (default)
    p = (prompt or "").strip() or "content that blends seamlessly with the surroundings"
    return f"{base} Task: replace ONLY the white region with: {p}."


def _build_reference_instruction(prompt: str) -> str:
    """Instruction for reference-image generative fill (fill mode only).

    Three images go on the wire in this order: FIRST = source ROI, SECOND = mask,
    THIRD = reference. The model must paint the masked region with the object from
    the reference, preserving its identity but adapting it to the scene.
    """
    base = (
        "You are editing the FIRST image. The SECOND image is a mask: pure white "
        "marks the ONLY region you may change; black pixels must stay byte-for-byte "
        "identical. The THIRD image is a REFERENCE showing the object to insert. "
        "Fill ONLY the masked (white) region with the object shown in the reference "
        "image; match its identity and appearance while adapting its scale, "
        "perspective, lighting and color to the scene. Do not recompose, crop, "
        "rotate or resize the FIRST image, and keep every unmasked pixel identical."
    )
    p = (prompt or "").strip()
    if p:
        return f"{base} Additional guidance: {p}."
    return base


def run_inpaint(
    *,
    image_bytes: bytes,
    mask_bytes: bytes,
    prompt: str,
    mode: str,
    roi: dict,
    seed: int | None,
    reference_bytes: bytes | None = None,
    provider: OpenRouterImageProvider | None = None,
) -> InpaintResult:
    """Execute the full inpaint pipeline and return the composited ROI.

    When `reference_bytes` is given (fill mode), the masked region is filled with
    the object shown in the reference image — the source ROI, mask and reference
    are sent together in one edit call. Everything after the creative step
    (re-align, color-match against the trusted pixels, feather + composite) is the
    same as a normal inpaint, so the result still blends seamlessly.
    """
    provider = provider or OpenRouterImageProvider()

    src = imaging.decode_rgba(image_bytes)
    roi_w = int(roi.get("width", src.width))
    roi_h = int(roi.get("height", src.height))

    # Resolve whether `image` is already the ROI crop or the full document image.
    # If dims match the ROI we treat it as the crop (the common web-client path);
    # otherwise we crop to ROI + padding and remember the offset for placement.
    if (src.width, src.height) == (roi_w, roi_h):
        roi_img = src
        place_x = int(roi.get("x", 0))
        place_y = int(roi.get("y", 0))
    else:
        left, top, right, bottom = imaging.clamp_roi(roi, src.width, src.height)
        roi_img = src.crop((left, top, right, bottom))
        place_x, place_y = left, top

    crop_size = roi_img.size  # (w, h) of the region actually sent to the model
    mask_img = imaging.decode_mask_l(mask_bytes, crop_size)

    # 2) creative step — send the source + mask (+ optional reference) with a
    # strong instruction; we still post-process as if the model ignored the mask.
    if reference_bytes is not None and mode == "fill":
        # Reference-image generative fill: [source, mask, reference] in one call.
        ref_img = imaging.decode_rgba(reference_bytes)
        instruction = _build_reference_instruction(prompt)
        edit_result: ImageResult = provider.image_edit_multi(
            images=[
                imaging.encode_png(roi_img),
                imaging.encode_png(mask_img.convert("RGBA")),
                imaging.encode_png(ref_img),
            ],
            instruction=instruction,
            seed=seed,
        )
    else:
        instruction = _build_instruction(mode, prompt)
        edit_result = provider.image_edit_with_mask(
            image_bytes=imaging.encode_png(roi_img),
            mask_bytes=imaging.encode_png(mask_img.convert("RGBA")),
            instruction=instruction,
            seed=seed,
        )

    # 3) re-align to the exact ROI grid — never trust the model's output size.
    result_img = imaging.resize_to(imaging.decode_rgba(edit_result.png_bytes), crop_size)

    # 4) color/exposure match using only the trusted (unmasked) pixels.
    # unmasked = inverse of the mask (255 where we must NOT have changed anything).
    unmasked = Image.eval(mask_img, lambda v: 255 - v)
    matched = imaging.color_match(result_img, roi_img, unmasked)

    # 5) feather the mask and composite the matched result back over the original.
    alpha = imaging.feather_mask(mask_img, erode_px=2, blur_px=3.0)
    composited = imaging.blend_masked(roi_img, matched, alpha)

    png = imaging.encode_png(composited)
    return InpaintResult(
        png_bytes=png,
        width=composited.width,
        height=composited.height,
        placement_roi={
            "x": place_x,
            "y": place_y,
            "width": composited.width,
            "height": composited.height,
        },
        cost_usd=edit_result.cost_usd,
        model=edit_result.model,
    )
