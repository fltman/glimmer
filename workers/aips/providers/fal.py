"""fal.ai provider adapter — upscale + segment.

fal exposes models over a queue API: POST to `https://queue.fal.run/<model>`
returns a request id; we poll `.../requests/<id>/status` until COMPLETED, then
fetch `.../requests/<id>` for the result payload. Many small models also accept a
synchronous POST to `https://fal.run/<model>` returning the result inline — we
use the sync endpoint for simplicity and fall back to nothing fancy.

Auth: `Authorization: Key <FAL_KEY>`. Images may be returned as a URL or a
data: URI; we resolve both to raw bytes.

Reuses the OpenRouter `ProviderError` contract so tasks handle failures uniformly.
"""

from __future__ import annotations

import base64
import binascii
import re

import httpx

from ..config import settings
from .openrouter import ProviderError

_TIMEOUT = httpx.Timeout(connect=15.0, read=240.0, write=60.0, pool=15.0)
_SYNC_BASE = "https://fal.run"

_DATA_URL_RE = re.compile(r"data:(?P<mime>[\w.+-]+/[\w.+-]+);base64,(?P<b64>[A-Za-z0-9+/=]+)")

# Default model slugs (overridable per-call). Clarity upscaler is the workhorse;
# BiRefNet gives a clean subject/foreground mask for segment.
DEFAULT_UPSCALE_MODEL = "fal-ai/clarity-upscaler"
DEFAULT_SEGMENT_MODEL = "fal-ai/birefnet"


def _auth_headers() -> dict[str, str]:
    if not settings.fal_key:
        raise ProviderError("no_upscale_provider", "FAL_KEY is not configured")
    return {
        "Authorization": f"Key {settings.fal_key}",
        "Content-Type": "application/json",
    }


def _data_uri(image_bytes: bytes, mime: str = "image/png") -> str:
    return f"data:{mime};base64," + base64.b64encode(image_bytes).decode("ascii")


def _resolve_image(url_or_data: str, client: httpx.Client) -> bytes:
    """A fal image field is either a hosted URL or a data: URI — return bytes."""
    if url_or_data.startswith("data:"):
        m = _DATA_URL_RE.search(url_or_data)
        if not m:
            raise ProviderError("provider_bad_response", "fal returned an unparseable data URI")
        try:
            return base64.b64decode(m.group("b64"))
        except (binascii.Error, ValueError) as exc:
            raise ProviderError("provider_bad_response", f"fal data URI decode failed: {exc}") from exc
    try:
        resp = client.get(url_or_data, timeout=_TIMEOUT)
        resp.raise_for_status()
    except httpx.HTTPError as exc:
        raise ProviderError("provider_network_error", f"fetching fal result failed: {exc}") from exc
    return resp.content


def _first_image_field(data: dict) -> str | None:
    """Pull the first image url/data field from a fal result payload.

    fal results vary: `{image:{url}}`, `{images:[{url}]}`, `{mask:{url}}` etc.
    We scan the common keys.
    """
    for key in ("image", "mask"):
        obj = data.get(key)
        if isinstance(obj, dict) and obj.get("url"):
            return obj["url"]
    images = data.get("images")
    if isinstance(images, list) and images:
        first = images[0]
        if isinstance(first, dict) and first.get("url"):
            return first["url"]
        if isinstance(first, str):
            return first
    return None


def _post_sync(model: str, payload: dict) -> dict:
    headers = _auth_headers()
    url = f"{_SYNC_BASE}/{model}"
    try:
        with httpx.Client(timeout=_TIMEOUT) as client:
            resp = client.post(url, headers=headers, json=payload)
    except httpx.HTTPError as exc:
        raise ProviderError("provider_network_error", f"fal request failed: {exc}") from exc

    if resp.status_code == 401:
        raise ProviderError("provider_auth_error", "fal rejected the API key (401)")
    if resp.status_code == 429:
        raise ProviderError("provider_rate_limited", "fal rate limited (429)")
    if resp.status_code >= 500:
        raise ProviderError("provider_unavailable", f"fal {resp.status_code}: {resp.text[:300]}")
    if resp.status_code != 200:
        raise ProviderError("provider_error", f"fal {resp.status_code}: {resp.text[:300]}")
    try:
        return resp.json()
    except ValueError as exc:
        raise ProviderError("provider_bad_response", "fal returned non-JSON") from exc


def upscale(image_bytes: bytes, scale: int, *, model: str | None = None) -> bytes:
    """Upscale via fal (Clarity/ESRGAN family). Returns PNG/JPEG bytes."""
    model = model or DEFAULT_UPSCALE_MODEL
    payload = {"image_url": _data_uri(image_bytes), "scale": int(scale)}
    data = _post_sync(model, payload)
    field = _first_image_field(data)
    if not field:
        raise ProviderError("no_image_in_response", "fal upscale returned no image")
    with httpx.Client(timeout=_TIMEOUT) as client:
        return _resolve_image(field, client)


def segment(
    image_bytes: bytes,
    *,
    points: list[dict] | None = None,
    box: dict | None = None,
    model: str | None = None,
) -> bytes:
    """Segment a subject via fal (BiRefNet/SAM). Returns a single-channel mask PNG.

    Point/box hints are forwarded when the chosen model supports them (SAM); for
    BiRefNet (foreground extraction) they are ignored by the model.
    """
    model = model or DEFAULT_SEGMENT_MODEL
    payload: dict = {"image_url": _data_uri(image_bytes)}
    if points:
        payload["point_coords"] = [[p.get("x"), p.get("y")] for p in points]
        payload["point_labels"] = [p.get("label", 1) for p in points]
    if box:
        payload["box"] = [box.get("x"), box.get("y"),
                          box.get("x", 0) + box.get("width", 0),
                          box.get("y", 0) + box.get("height", 0)]
    data = _post_sync(model, payload)
    field = _first_image_field(data)
    if not field:
        raise ProviderError("no_image_in_response", "fal segment returned no mask")
    with httpx.Client(timeout=_TIMEOUT) as client:
        return _resolve_image(field, client)
