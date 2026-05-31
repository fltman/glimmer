"""Remove-reflections pipeline — erase glare/reflections off glass, windows,
water, screens and eyeglasses while keeping whatever is BEHIND the glass intact.

There is no mask-aware provider endpoint (the OpenRouter image model edits a
whole image from an instruction), so we synthesize a confined, seamless edit the
same way the inpaint pipeline does:

  1. Resolve the ROI. If a `roi` is supplied AND it is a strict sub-region of the
     image, crop to roi + ~30% context padding (so the model sees the glass and
     its surroundings) and remember the offset for placement. If no roi is given
     (or it spans the whole image), the entire image is the edit region.
  2. Build a precise reflection-removal instruction; `strength` (0..1) scales how
     aggressive the suppression is, from a light hotspot knock-back to a full
     reveal of what is behind the glass.
  3. Run the model edit (`OpenRouterImageProvider.image_edit`).
  4. Re-align the model output to the exact edit-region pixel grid (never trust
     the returned resolution).
  5. Color/exposure-match the output back to the original edit region (so a
     global color shift introduced by the model is removed), then — when the edit
     was confined to a padded ROI — feather a region mask and composite the
     cleaned crop back over the original so pixels outside the ROI stay stable.

Returns the resulting PNG plus the placement rect (the roi when confined, else
the whole image) to drop it back into the document as a new layer.
"""

from __future__ import annotations

from dataclasses import dataclass

from PIL import Image

from ..providers.openrouter import ImageResult, OpenRouterImageProvider
from . import imaging


@dataclass
class RemoveReflectionsResult:
    png_bytes: bytes
    width: int
    height: int
    #: Where the result goes in the document (roi when confined, else full image).
    placement_roi: dict
    cost_usd: float | None
    model: str


def _strength_phrase(strength: float) -> str:
    """How aggressively to suppress reflections, scaled by `strength` (0..1)."""
    if strength >= 0.75:
        return (
            "Remove reflections and glare COMPLETELY and fully reveal whatever is "
            "behind the glass/surface, reconstructing the hidden detail plausibly"
        )
    if strength >= 0.4:
        return (
            "Clearly reduce the reflections and glare, revealing most of what is "
            "behind the glass/surface while keeping it looking natural"
        )
    return (
        "Gently knock back only the strongest reflection hotspots and glare, "
        "keeping the edit subtle"
    )


def _build_instruction(strength: float, confined: bool) -> str:
    """Compose a precise reflection-removal instruction.

    `confined` is True when only a padded ROI was sent (so the model must not
    touch the surrounding context); False for a whole-image pass.
    """
    region = (
        "Work ONLY on the reflective surface in this crop"
        if confined
        else "Work across the whole image"
    )
    parts = [
        f"{region}. Remove unwanted reflections, glare and specular hotspots from "
        "reflective surfaces — glass, windows, water, screens/monitors, and "
        "eyeglass lenses — so the subject behind the glass becomes clearly "
        "visible.",
        f"{_strength_phrase(strength)}.",
        "Preserve the surface itself (the frame, glass edges, screen bezel, lens "
        "rims) and everything that is genuinely behind or around it; do not "
        "invent new objects, text or logos.",
        "CRITICAL: change ONLY the reflections/glare. Keep the framing, "
        "perspective, geometry, colors and exposure of everything else EXACTLY "
        "the same. Do not recompose, crop, rotate or resize the image.",
    ]
    return " ".join(parts)


def run_remove_reflections(
    *,
    image_bytes: bytes,
    roi: dict | None,
    strength: float,
    seed: int | None,
    provider: OpenRouterImageProvider | None = None,
) -> RemoveReflectionsResult:
    """Execute the full remove-reflections pipeline.

    When `roi` is a strict sub-region of the image, the edit is confined to a
    context-padded crop and feather-blended back so pixels outside the ROI stay
    byte-stable. Otherwise the whole image is cleaned.
    """
    provider = provider or OpenRouterImageProvider()
    strength = float(max(0.0, min(1.0, strength)))

    src = imaging.decode_rgba(image_bytes)

    # Decide whether we confine to a padded ROI or process the whole image.
    confined = False
    crop_box: tuple[int, int, int, int] | None = None
    if roi:
        rx = int(roi.get("x", 0))
        ry = int(roi.get("y", 0))
        rw = int(roi.get("width", src.width))
        rh = int(roi.get("height", src.height))
        # Only confine when the ROI is a real sub-region (not the whole frame).
        spans_whole = rx <= 0 and ry <= 0 and rw >= src.width and rh >= src.height
        if rw > 0 and rh > 0 and not spans_whole:
            confined = True
            crop_box = imaging.clamp_roi(roi, src.width, src.height)

    if confined and crop_box is not None:
        left, top, right, bottom = crop_box
        edit_img = src.crop((left, top, right, bottom))
        place_x, place_y = left, top
    else:
        edit_img = src
        place_x, place_y = 0, 0

    edit_size = edit_img.size  # (w, h) actually sent to the model

    # 2) creative step — instruction-driven reflection removal.
    instruction = _build_instruction(strength, confined)
    edit_result: ImageResult = provider.image_edit(
        imaging.encode_png(edit_img),
        instruction,
        seed=seed,
    )

    # 3) re-align to the exact edit-region grid — never trust the output size.
    result_img = imaging.resize_to(
        imaging.decode_rgba(edit_result.png_bytes), edit_size
    )

    # 4) color/exposure-match the output back to the original edit region. The
    # whole region is "trusted" for the fit (we want the model's content but the
    # original's grade), so weight every pixel fully — this removes any global
    # color/exposure shift the model introduced.
    full_weight = Image.new("L", edit_size, color=255)
    matched = imaging.color_match(result_img, edit_img, full_weight)

    if confined:
        # 5) feather a region mask (white over the whole crop) and composite the
        # cleaned crop back over the original crop so the seam ramps softly and
        # pixels outside the ROI stay exactly the original.
        region_mask = Image.new("L", edit_size, color=255)
        alpha = imaging.feather_mask(region_mask, erode_px=2, blur_px=3.0)
        out_img = imaging.blend_masked(edit_img, matched, alpha)
    else:
        out_img = matched

    png = imaging.encode_png(out_img)
    return RemoveReflectionsResult(
        png_bytes=png,
        width=out_img.width,
        height=out_img.height,
        placement_roi={
            "x": place_x,
            "y": place_y,
            "width": out_img.width,
            "height": out_img.height,
        },
        cost_usd=edit_result.cost_usd,
        model=edit_result.model,
    )
