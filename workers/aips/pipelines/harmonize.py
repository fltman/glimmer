"""Harmonize pipeline — relight/color-grade an inserted subject to its scene.

When a cutout subject (RGBA, alpha = silhouette) is dropped onto a background
composite, it usually looks pasted: wrong lighting direction, color temperature,
contrast, and no contact shadow. We fix this without a native endpoint:

  1. Composite the foreground over the background to give the model the full,
     plausible scene (so it can reason about light direction / temperature).
  2. Send that composite to a Gemini-style img2img edit with an instruction to
     relight + color-grade ONLY the inserted subject, add a plausible contact
     shadow, keep the subject's identity, and leave the background unchanged.
     The instruction's strength language scales with `strength` (0..1).
  3. Re-align the model output to the exact size (never trust the returned res).
  4. Optionally color/exposure-match the SUBJECT region only, back toward the
     model's harmonized output's own statistics blended with the original
     subject — keeps identity while accepting the relight (gated by strength).
  5. Re-key the harmonized RGB through the ORIGINAL foreground alpha so the
     returned layer is a clean RGBA cutout the web client can overlay/replace the
     foreground layer with. Any contact shadow the model painted onto the
     background is intentionally dropped here — it lives below the subject and is
     out of scope for a single subject-layer replacement.

Returns the harmonized subject as an RGBA PNG plus a placement rect.
"""

from __future__ import annotations

from dataclasses import dataclass

from PIL import Image

from ..providers.openrouter import ImageResult, OpenRouterImageProvider
from . import imaging


@dataclass
class HarmonizeResult:
    png_bytes: bytes
    width: int
    height: int
    #: Where the harmonized subject layer goes in the document.
    placement_roi: dict
    cost_usd: float | None
    model: str


def _build_instruction(strength: float) -> str:
    """Relight/grade instruction; intensity language scales with `strength`."""
    if strength >= 0.75:
        degree = "Strongly"
    elif strength >= 0.4:
        degree = "Noticeably"
    else:
        degree = "Subtly"
    return (
        "You are compositing. This image shows a subject that was inserted into a "
        f"scene and currently looks pasted-in. {degree} relight and color-grade the "
        "inserted subject so it matches the scene: align its lighting direction, "
        "color temperature, contrast and exposure to the surrounding environment, "
        "and add a plausible soft contact shadow where the subject meets the "
        "ground/surface. Keep the subject's identity, shape and pose exactly. Do "
        "NOT change the background, its framing, perspective or content, and do "
        "not crop, rotate or resize the image."
    )


def run_harmonize(
    *,
    foreground_bytes: bytes,
    background_bytes: bytes,
    roi: dict | None,
    strength: float | None,
    seed: int | None,
    provider: OpenRouterImageProvider | None = None,
) -> HarmonizeResult:
    """Execute the harmonize pipeline and return the harmonized subject layer."""
    provider = provider or OpenRouterImageProvider()

    s = 0.6 if strength is None else float(max(0.0, min(1.0, strength)))

    fg = imaging.decode_rgba(foreground_bytes)
    bg = imaging.decode_rgba(background_bytes)
    # Work on the background grid; the subject layer is returned at that size.
    size = bg.size
    if fg.size != size:
        fg = imaging.resize_to(fg, size)

    # Original subject alpha (the silhouette we re-key through at the end).
    subject_alpha = imaging.alpha_channel(fg)

    # 1) composite the subject over the scene so the model sees the full picture.
    composite = imaging.composite_over(fg, bg)

    # 2) creative step — relight + grade the subject, keep the background.
    instruction = _build_instruction(s)
    edit_result: ImageResult = provider.image_edit(
        image_bytes=imaging.encode_png(composite),
        instruction=instruction,
        seed=seed,
    )

    # 3) re-align to the exact grid — never trust the model's output size.
    result_img = imaging.resize_to(imaging.decode_rgba(edit_result.png_bytes), size)

    # 4) keep the subject identity: blend the model's relit RGB with the original
    # subject RGB by `strength`, but ONLY inside the subject silhouette. Low
    # strength stays close to the original cutout; high strength trusts the model.
    #    relit = original*(1-s) + model*s   (over the whole frame; we re-key next)
    blended = imaging.blend_masked(
        fg.convert("RGBA"),
        result_img.convert("RGBA"),
        Image.eval(Image.new("L", size, 255), lambda v: int(round(v * s))),
    )

    # 5) re-key through the ORIGINAL subject alpha so we return a clean cutout
    # (the harmonized RGB inside the silhouette, transparent everywhere else).
    out = blended.convert("RGBA")
    out.putalpha(subject_alpha)

    place = roi or {"x": 0, "y": 0, "width": size[0], "height": size[1]}
    placement_roi = {
        "x": int(place.get("x", 0)),
        "y": int(place.get("y", 0)),
        "width": int(place.get("width", size[0])),
        "height": int(place.get("height", size[1])),
    }

    png = imaging.encode_png(out)
    return HarmonizeResult(
        png_bytes=png,
        width=out.width,
        height=out.height,
        placement_roi=placement_roi,
        cost_usd=edit_result.cost_usd,
        model=edit_result.model,
    )
