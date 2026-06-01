"""Replicate provider adapter — upscale + segment fallback.

Replicate runs models as predictions: POST `/v1/predictions` with a model
`version` and `input`, then poll the returned `urls.get` until `status` is
`succeeded`/`failed`. Output is typically a URL (or list of URLs) to the result
file, which we download to bytes.

Auth: `Authorization: Bearer <REPLICATE_API_TOKEN>`. Used only when FAL_KEY is
absent (see tasks/upscale.py, tasks/segment.py).

Reuses the OpenRouter `ProviderError` contract.
"""

from __future__ import annotations

import base64
import time

import httpx

from ..config import settings
from . import resilience
from .openrouter import ProviderError

_TIMEOUT = httpx.Timeout(connect=15.0, read=60.0, write=60.0, pool=15.0)
_API = "https://api.replicate.com/v1/predictions"

# Pinned model versions (Replicate requires an explicit version hash). These are
# well-known public models; override via the `version` arg if they rotate.
# Real-ESRGAN (nightmareai) for upscale; SAM (meta/segment-anything-ish) for segment.
DEFAULT_UPSCALE_VERSION = "f121d640bd286e1fdc67f9799164c1d5be36ff74576ee11c803ae5b665dd46aa"  # real-esrgan
DEFAULT_SEGMENT_VERSION = "fe97b453a6455861e3bac769b441ca1f1086110da7466dbb65cf1eecfd60dc83"  # SAM

# Max wall-clock to wait for a prediction before giving up.
_POLL_TIMEOUT_S = 240.0
_POLL_INTERVAL_S = 2.0


def _auth_headers() -> dict[str, str]:
    if not settings.replicate_api_token:
        raise ProviderError("no_upscale_provider", "REPLICATE_API_TOKEN is not configured")
    return {
        "Authorization": f"Bearer {settings.replicate_api_token}",
        "Content-Type": "application/json",
    }


def _data_uri(image_bytes: bytes, mime: str = "image/png") -> str:
    return f"data:{mime};base64," + base64.b64encode(image_bytes).decode("ascii")


def _create_prediction(version: str, input_payload: dict) -> dict:
    """POST a new prediction (the call worth retrying) and return its initial obj.

    Retryable statuses (429/5xx) carry their Retry-After to the retry loop; the
    status→code mapping is unchanged.
    """
    headers = _auth_headers()
    try:
        with httpx.Client(timeout=_TIMEOUT) as client:
            resp = client.post(_API, headers=headers, json={"version": version, "input": input_payload})
    except httpx.TimeoutException as exc:
        raise ProviderError("provider_timeout", f"Replicate timed out: {exc}") from exc
    except httpx.HTTPError as exc:
        raise ProviderError("provider_network_error", f"Replicate request failed: {exc}") from exc

    if resp.status_code == 401:
        raise ProviderError("provider_auth_error", "Replicate rejected the token (401)")
    if resp.status_code == 429:
        raise resilience.attach_retry_after(
            ProviderError("provider_rate_limited", "Replicate rate limited (429)"),
            resp.headers.get("Retry-After"),
        )
    if resp.status_code >= 500:
        raise resilience.attach_retry_after(
            ProviderError("provider_unavailable", f"Replicate {resp.status_code}: {resp.text[:300]}"),
            resp.headers.get("Retry-After"),
        )
    if resp.status_code not in (200, 201):
        raise ProviderError("provider_error", f"Replicate {resp.status_code}: {resp.text[:300]}")
    return resp.json()


def _run_prediction(version: str, input_payload: dict) -> dict:
    """Create a prediction (retry/circuit-wrapped) and poll to completion.

    Only the CREATE POST is retried — once a prediction exists, re-POSTing would
    create (and pay for) a duplicate, so the poll loop keeps its single hard
    wall-clock timeout instead of being retried.
    """
    pred = resilience.request_with_retry(
        lambda: _create_prediction(version, input_payload),
        provider="replicate",
    )

    headers = _auth_headers()
    try:
        with httpx.Client(timeout=_TIMEOUT) as client:
            get_url = (pred.get("urls") or {}).get("get")
            deadline = time.monotonic() + _POLL_TIMEOUT_S
            while pred.get("status") in ("starting", "processing") and get_url:
                if time.monotonic() > deadline:
                    raise ProviderError("provider_timeout", "Replicate prediction timed out")
                time.sleep(_POLL_INTERVAL_S)
                poll = client.get(get_url, headers=headers)
                if poll.status_code != 200:
                    raise ProviderError("provider_error", f"Replicate poll {poll.status_code}: {poll.text[:200]}")
                pred = poll.json()
    except httpx.HTTPError as exc:
        raise ProviderError("provider_network_error", f"Replicate request failed: {exc}") from exc

    if pred.get("status") != "succeeded":
        msg = pred.get("error") or pred.get("status") or "unknown"
        raise ProviderError("provider_error", f"Replicate prediction not successful: {msg}")
    return pred


def _download_output(pred: dict) -> bytes:
    """Resolve `output` (URL or list of URLs / data URI) to bytes."""
    output = pred.get("output")
    url: str | None = None
    if isinstance(output, str):
        url = output
    elif isinstance(output, list) and output:
        # Last item is usually the final image for multi-step models.
        cand = output[-1]
        url = cand if isinstance(cand, str) else None
    elif isinstance(output, dict):
        url = output.get("url") or output.get("image")
    if not url:
        raise ProviderError("no_image_in_response", "Replicate returned no output URL")

    if url.startswith("data:"):
        try:
            return base64.b64decode(url.split(",", 1)[1])
        except (ValueError, IndexError) as exc:
            raise ProviderError("provider_bad_response", f"Replicate data URI decode failed: {exc}") from exc
    try:
        with httpx.Client(timeout=httpx.Timeout(connect=15.0, read=120.0, write=30.0, pool=15.0)) as client:
            resp = client.get(url)
            resp.raise_for_status()
            return resp.content
    except httpx.HTTPError as exc:
        raise ProviderError("provider_network_error", f"fetching Replicate output failed: {exc}") from exc


def upscale(image_bytes: bytes, scale: int, *, version: str | None = None) -> bytes:
    """Upscale via Replicate (Real-ESRGAN). Returns image bytes.

    Raw output is cached on the call signature so a redelivered / retried task
    re-reads the already-paid bytes instead of creating a new prediction.
    """
    version = version or DEFAULT_UPSCALE_VERSION
    key = resilience.make_cache_key(
        capability="replicate_upscale", model=version, parts=[image_bytes, scale]
    )

    def _produce() -> resilience.CachedOutput:
        pred = _run_prediction(version, {"image": _data_uri(image_bytes), "scale": int(scale)})
        return resilience.CachedOutput(
            data=_download_output(pred), cost_usd=None, model="replicate", cached=False
        )

    return resilience.get_or_call(key, _produce).data


def segment(
    image_bytes: bytes,
    *,
    points: list[dict] | None = None,
    box: dict | None = None,
    version: str | None = None,
) -> bytes:
    """Segment via Replicate (SAM). Returns a single-channel mask PNG (bytes)."""
    version = version or DEFAULT_SEGMENT_VERSION
    payload: dict = {"image": _data_uri(image_bytes)}
    if points:
        # SAM-on-Replicate accepts coordinate strings; forward both axes.
        payload["point_coords"] = [[p.get("x"), p.get("y")] for p in points]
        payload["point_labels"] = [p.get("label", 1) for p in points]
    if box:
        payload["box"] = [box.get("x"), box.get("y"),
                          box.get("x", 0) + box.get("width", 0),
                          box.get("y", 0) + box.get("height", 0)]

    key = resilience.make_cache_key(
        capability="replicate_segment",
        model=version,
        parts=[image_bytes, repr(points), repr(box)],
    )

    def _produce() -> resilience.CachedOutput:
        pred = _run_prediction(version, payload)
        return resilience.CachedOutput(
            data=_download_output(pred), cost_usd=None, model="replicate", cached=False
        )

    return resilience.get_or_call(key, _produce).data
