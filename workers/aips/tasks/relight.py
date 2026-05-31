"""relight Celery task — directional/colored AI relighting. Queue: `gen`.

Re-lights the active image with a chosen key-light direction, color temperature
and intensity (optionally relighting it INTO a new scene/environment) while
keeping the subject's identity, shapes and composition unchanged. Implemented as
a Gemini-style img2img edit: we build a precise relight INSTRUCTION from the
inputs and run it through `OpenRouterImageProvider().image_edit`.

The result is re-aligned to the input pixel grid (never trust the model's output
size), PNG-normalized, and returned as a full-frame image artifact. Cost is
captured best-effort like upscale.py.

`inputs` is a RelightInputs dict:
  {image: AssetRef, direction, color?, intensity?, backgroundPrompt?, seed?}.
"""

from __future__ import annotations

import logging

from ..celery_app import app
from ..contracts import Job, JobArtifact, new_job, now_iso
from ..pipelines import imaging
from ..providers.openrouter import OpenRouterImageProvider, ProviderError
from ..redis_io import load_job, publish_progress
from ..storage import build_key, download_object, presign_get, sha256_hex, upload_bytes

log = logging.getLogger("aips.tasks.relight")

TASK_NAME = "aips.relight"

#: Allowed key-light directions (mirror RELIGHT_DIRECTIONS in shared-types).
_DIRECTIONS = ("left", "right", "top", "bottom", "front", "behind")

#: Default key-light color when none is supplied: a warm white.
_DEFAULT_COLOR = "#ffe6c0"

#: How a direction reads as natural language for the model.
_DIRECTION_PHRASE = {
    "left": "from the LEFT side of the frame (a side/key light entering from the left)",
    "right": "from the RIGHT side of the frame (a side/key light entering from the right)",
    "top": "from directly ABOVE (overhead/top light)",
    "bottom": "from BELOW (an uplight / footlight pointing upward)",
    "front": "from the FRONT, on the camera axis (flat frontal light)",
    "behind": "from BEHIND the subject (backlight / rim light that haloes the edges)",
}

#: Where shadows fall, given where the light comes FROM (the opposite side).
_SHADOW_PHRASE = {
    "left": "casting soft shadows toward the right",
    "right": "casting soft shadows toward the left",
    "top": "casting soft shadows downward, under forms",
    "bottom": "throwing shadows upward in an eerie, dramatic way",
    "front": "minimizing cast shadows, filling the form evenly",
    "behind": "leaving the camera-facing side in relative shadow with a bright rim",
}


def _fail(job: Job, code: str, message: str) -> None:
    job["status"] = "failed"
    job["stage"] = "done"
    job["progress"] = 1.0
    job["error"] = {"code": code, "message": message}
    job["finishedAt"] = now_iso()
    publish_progress(job)


def _hex_to_rgb(value: str) -> tuple[int, int, int] | None:
    """Parse a #RRGGBB / #RGB hex string to an (r,g,b) tuple, or None if invalid."""
    if not value or not isinstance(value, str):
        return None
    s = value.strip().lstrip("#")
    if len(s) == 3:
        s = "".join(ch * 2 for ch in s)
    if len(s) != 6:
        return None
    try:
        return (int(s[0:2], 16), int(s[2:4], 16), int(s[4:6], 16))
    except ValueError:
        return None


def _color_description(color_hex: str) -> str:
    """Human/temperature reading of a hex color, for the relight instruction."""
    rgb = _hex_to_rgb(color_hex)
    if rgb is None:
        return f"a warm white light (hex {_DEFAULT_COLOR})"
    r, g, b = rgb
    # Crude but effective warm/cool/neutral read from the R vs B balance.
    if r - b > 30:
        temp = "warm (golden/amber)"
    elif b - r > 30:
        temp = "cool (blue/daylight)"
    else:
        temp = "neutral white"
    return f"{temp} light, color hex #{r:02x}{g:02x}{b:02x}"


def _intensity_phrase(intensity: float) -> str:
    if intensity >= 0.75:
        return (
            "Make the relighting DRAMATIC and high-contrast, with strong highlights "
            "and deep, well-defined shadows"
        )
    if intensity >= 0.4:
        return (
            "Make the relighting clearly visible, with balanced highlights and "
            "natural, soft-edged shadows"
        )
    return (
        "Make the relighting SUBTLE — a gentle directional shaping with soft, "
        "low-contrast shadows"
    )


def _build_instruction(
    direction: str, color_hex: str, intensity: float, background_prompt: str | None
) -> str:
    """Compose a precise relight instruction from the inputs."""
    dir_phrase = _DIRECTION_PHRASE.get(direction, _DIRECTION_PHRASE["front"])
    shadow_phrase = _SHADOW_PHRASE.get(direction, _SHADOW_PHRASE["front"])
    color_phrase = _color_description(color_hex)
    strength_phrase = _intensity_phrase(intensity)

    parts = [
        "Relight this image. Add a dominant key light coming "
        f"{dir_phrase}, {shadow_phrase}.",
        f"The light is {color_phrase}; let it set the overall color temperature "
        "of highlights and the ambient fill.",
        f"{strength_phrase}.",
    ]

    if background_prompt and background_prompt.strip():
        parts.append(
            "Relight the scene as if the subject were in this environment: "
            f"\"{background_prompt.strip()}\". Adapt the background lighting, ambient "
            "color and reflections to that environment."
        )

    parts.append(
        "CRITICAL: change ONLY the lighting — its direction, color temperature, "
        "shadows and highlights. Keep the subject's identity, shapes, pose, "
        "materials and the overall composition EXACTLY the same. Do not move, add "
        "or remove objects, do not change the framing, and do not crop, rotate or "
        "resize the image."
    )
    return " ".join(parts)


@app.task(name=TASK_NAME, bind=True)
def relight(self, *, job_id: str, inputs: dict, user_id: str = "anon", idempotency_key=None):
    job: Job = load_job(job_id) or new_job(job_id, "relight")  # type: ignore[arg-type]

    # Idempotency: never re-run (and re-charge) an already-finished job on retry.
    if job.get("status") == "succeeded":
        return {"jobId": job_id, "status": "succeeded"}

    inputs = inputs or {}
    image_ref = inputs.get("image") or {}
    key_in = image_ref.get("key")
    direction = str(inputs.get("direction") or "front")
    color_hex = inputs.get("color") or _DEFAULT_COLOR
    intensity_raw = inputs.get("intensity")
    intensity = (
        0.6 if intensity_raw is None else float(max(0.0, min(1.0, float(intensity_raw))))
    )
    background_prompt = inputs.get("backgroundPrompt")

    if not key_in:
        _fail(job, "invalid_inputs", "relight requires inputs.image.key")
        return {"jobId": job_id, "status": "failed"}
    if direction not in _DIRECTIONS:
        _fail(
            job,
            "invalid_inputs",
            f"relight direction must be one of {_DIRECTIONS}, got {direction!r}",
        )
        return {"jobId": job_id, "status": "failed"}

    provider = OpenRouterImageProvider()
    job["providerResolved"] = provider.model

    # 1) download input
    job["status"] = "running"
    job["stage"] = "calling_model"
    job["progress"] = 0.15
    publish_progress(job)

    try:
        image_bytes = download_object(key_in)
    except Exception as exc:  # noqa: BLE001
        log.exception("relight download failed job=%s key=%s", job_id, key_in)
        _fail(job, "storage_error", f"Could not download input image: {exc}")
        return {"jobId": job_id, "status": "failed"}

    # Remember the input grid so we can re-align the model output.
    try:
        src = imaging.decode_rgba(image_bytes)
        target_size = src.size
    except Exception as exc:  # noqa: BLE001
        log.exception("relight decode failed job=%s", job_id)
        _fail(job, "decode_failed", f"Could not decode input image: {exc}")
        return {"jobId": job_id, "status": "failed"}

    # 2) call model
    job["progress"] = 0.4
    publish_progress(job)
    instruction = _build_instruction(direction, color_hex, intensity, background_prompt)
    try:
        result = provider.image_edit(image_bytes, instruction, seed=inputs.get("seed"))
    except ProviderError as exc:
        log.warning("relight provider error job=%s code=%s: %s", job_id, exc.code, exc.message)
        _fail(job, exc.code, exc.message)
        return {"jobId": job_id, "status": "failed"}
    except Exception as exc:  # noqa: BLE001
        log.exception("relight unexpected error job=%s", job_id)
        _fail(job, "internal_error", str(exc))
        return {"jobId": job_id, "status": "failed"}

    # 3) post-processing — re-align to the input grid + PNG-normalize.
    job["stage"] = "post_processing"
    job["progress"] = 0.85
    if result.cost_usd is not None:
        job["costUsd"] = result.cost_usd
    job["providerResolved"] = result.model
    publish_progress(job)

    try:
        relit = imaging.resize_to(imaging.decode_rgba(result.png_bytes), target_size)
        png = imaging.encode_png(relit)
    except Exception as exc:  # noqa: BLE001
        log.exception("relight post-processing failed job=%s", job_id)
        _fail(job, "decode_failed", f"Could not process relit image: {exc}")
        return {"jobId": job_id, "status": "failed"}

    digest = sha256_hex(png)
    key = build_key(user_id, digest, "png")
    try:
        upload_bytes(key, png, "image/png")
    except Exception as exc:  # noqa: BLE001
        log.exception("relight upload failed job=%s", job_id)
        _fail(job, "storage_error", f"Failed to store result: {exc}")
        return {"jobId": job_id, "status": "failed"}

    # Friendly layer name, e.g. "Relit (left, warm)".
    rgb = _hex_to_rgb(color_hex)
    if rgb is None:
        temp_word = "warm"
    else:
        r, _g, b = rgb
        temp_word = "warm" if r - b > 30 else "cool" if b - r > 30 else "neutral"
    suggested = f"Relit ({direction}, {temp_word})"

    artifact: JobArtifact = {
        "kind": "image",
        "url": presign_get(key, expires_seconds=24 * 60 * 60),
        "contentType": "image/png",
        "width": relit.width,
        "height": relit.height,
        "placement": {
            "roi": {"x": 0, "y": 0, "width": relit.width, "height": relit.height},
            "suggestedLayerName": suggested,
        },
    }
    job["artifacts"] = [artifact]
    job["status"] = "succeeded"
    job["stage"] = "done"
    job["progress"] = 1.0
    job["finishedAt"] = now_iso()
    publish_progress(job)

    return {"jobId": job_id, "status": "succeeded", "key": key}
