"""OpenRouter image provider.

OpenRouter exposes image-generation models (e.g. Gemini `gemini-3-pro-image-preview`)
through the OpenAI-compatible **chat/completions** endpoint. The model returns the
generated image inline in the assistant message — either as `message.images[*]`
(OpenRouter's image array, each `{type:"image_url", image_url:{url:"data:image/...;base64,..."}}`)
or embedded as a `data:` URL inside the text content. We parse whichever is present
and return raw PNG bytes plus any cost reported in `usage`.
"""

from __future__ import annotations

import base64
import binascii
import re
from dataclasses import dataclass
from io import BytesIO

import httpx
from PIL import Image

from ..config import settings

# data:image/png;base64,AAAA...
_DATA_URL_RE = re.compile(r"data:(?P<mime>image/[\w.+-]+);base64,(?P<b64>[A-Za-z0-9+/=]+)")

# Request/connect/read timeouts: image gen is slow, give it room.
_TIMEOUT = httpx.Timeout(connect=15.0, read=180.0, write=60.0, pool=15.0)


class ProviderError(RuntimeError):
    """Raised on a non-retryable or exhausted provider failure.

    Carries a stable `code` for the Job.error contract.
    """

    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code
        self.message = message


@dataclass
class ImageResult:
    png_bytes: bytes
    width: int
    height: int
    #: Cost in USD as reported by OpenRouter `usage.cost`, if present.
    cost_usd: float | None
    #: Resolved model id that actually served the request.
    model: str


class OpenRouterImageProvider:
    """Thin client for OpenRouter image generation / editing."""

    def __init__(
        self,
        api_key: str | None = None,
        base_url: str | None = None,
        model: str | None = None,
    ):
        self.api_key = api_key or settings.openrouter_api_key
        self.base_url = (base_url or settings.openrouter_base_url).rstrip("/")
        self.model = model or settings.openrouter_image_model

    # ── public API ────────────────────────────────────────────

    def text_to_image(
        self,
        prompt: str,
        *,
        negative_prompt: str | None = None,
        width: int | None = None,
        height: int | None = None,
        seed: int | None = None,
    ) -> ImageResult:
        text = prompt
        if negative_prompt:
            text += f"\n\nAvoid: {negative_prompt}"
        if width and height:
            text += f"\n\nTarget dimensions: {width}x{height} pixels."
        content: list[dict] = [{"type": "text", "text": text}]
        return self._generate(content, seed=seed)

    def image_edit(self, image_bytes: bytes, instruction: str, *, seed: int | None = None) -> ImageResult:
        """Edit an image with a natural-language instruction (Gemini-style edit)."""
        data_url = "data:image/png;base64," + base64.b64encode(image_bytes).decode("ascii")
        content = [
            {"type": "text", "text": instruction},
            {"type": "image_url", "image_url": {"url": data_url}},
        ]
        return self._generate(content, seed=seed)

    def image_edit_with_mask(
        self,
        *,
        image_bytes: bytes,
        mask_bytes: bytes,
        instruction: str,
        seed: int | None = None,
    ) -> ImageResult:
        """Edit an image given a companion mask image.

        Gemini-style models accept multiple input images in one message, so we
        send the source first and the mask second. The instruction must explain
        the convention (white = editable); the inpaint pipeline post-processes
        the result regardless, so a model that ignores the mask still composites
        correctly.
        """
        img_url = "data:image/png;base64," + base64.b64encode(image_bytes).decode("ascii")
        mask_url = "data:image/png;base64," + base64.b64encode(mask_bytes).decode("ascii")
        content = [
            {"type": "text", "text": instruction},
            {"type": "image_url", "image_url": {"url": img_url}},
            {"type": "image_url", "image_url": {"url": mask_url}},
        ]
        return self._generate(content, seed=seed)

    def image_edit_multi(
        self,
        *,
        images: list[bytes],
        instruction: str,
        seed: int | None = None,
    ) -> ImageResult:
        """Edit using several input images sent in a single message.

        Gemini-style models accept multiple images per message; the order is
        significant and the instruction must spell out the role of each (e.g.
        "FIRST = source, SECOND = mask, THIRD = reference"). Used by the
        reference-image generative fill and harmonize pipelines. The caller
        post-processes the result (re-align / color-match / composite) so a model
        that under-uses an input still produces a usable, blendable image.
        """
        if not images:
            raise ProviderError("invalid_inputs", "image_edit_multi requires at least one image")
        content: list[dict] = [{"type": "text", "text": instruction}]
        for img in images:
            data_url = "data:image/png;base64," + base64.b64encode(img).decode("ascii")
            content.append({"type": "image_url", "image_url": {"url": data_url}})
        return self._generate(content, seed=seed)

    # ── internals ─────────────────────────────────────────────

    def _generate(self, content: list[dict], *, seed: int | None) -> ImageResult:
        body: dict = {
            "model": self.model,
            "messages": [{"role": "user", "content": content}],
            # Ask OpenRouter to return image modality where the model supports it.
            "modalities": ["image", "text"],
        }
        if seed is not None:
            body["seed"] = seed

        headers = {
            "Authorization": f"Bearer {self.api_key}",
            "Content-Type": "application/json",
            # OpenRouter attribution headers (optional but recommended).
            "HTTP-Referer": "https://ai-ps.local",
            "X-Title": "ai-ps",
        }

        try:
            with httpx.Client(timeout=_TIMEOUT) as client:
                resp = client.post(
                    f"{self.base_url}/chat/completions",
                    headers=headers,
                    json=body,
                )
        except httpx.HTTPError as exc:
            raise ProviderError("provider_network_error", f"OpenRouter request failed: {exc}") from exc

        if resp.status_code == 429:
            raise ProviderError("provider_rate_limited", "OpenRouter rate limited (429)")
        if resp.status_code >= 500:
            raise ProviderError("provider_unavailable", f"OpenRouter {resp.status_code}: {resp.text[:300]}")
        if resp.status_code in (400, 422):
            raise ProviderError("provider_bad_request", f"OpenRouter {resp.status_code}: {resp.text[:300]}")
        if resp.status_code == 403:
            raise ProviderError("content_policy", f"OpenRouter rejected request (403): {resp.text[:300]}")
        if resp.status_code != 200:
            raise ProviderError("provider_error", f"OpenRouter {resp.status_code}: {resp.text[:300]}")

        try:
            data = resp.json()
        except ValueError as exc:
            raise ProviderError("provider_bad_response", "OpenRouter returned non-JSON") from exc

        png = self._extract_image_bytes(data)
        if png is None:
            raise ProviderError(
                "no_image_in_response",
                "OpenRouter response contained no image data",
            )

        try:
            img = Image.open(BytesIO(png)).convert("RGBA")
        except Exception as exc:  # noqa: BLE001
            raise ProviderError("decode_failed", f"Could not decode returned image: {exc}") from exc

        # Normalize to PNG bytes regardless of what the model returned.
        out = BytesIO()
        img.save(out, format="PNG")

        usage = data.get("usage") or {}
        cost = usage.get("cost")
        model_used = data.get("model") or self.model
        return ImageResult(
            png_bytes=out.getvalue(),
            width=img.width,
            height=img.height,
            cost_usd=float(cost) if isinstance(cost, (int, float)) else None,
            model=model_used,
        )

    @staticmethod
    def _extract_image_bytes(data: dict) -> bytes | None:
        """Pull image bytes out of an OpenRouter chat completion response.

        Handles three shapes:
          1. choices[0].message.images[*].image_url.url (data URL)  — OpenRouter image array
          2. choices[0].message.content as a list with image_url parts
          3. a data: URL embedded in the text content
        """
        choices = data.get("choices") or []
        if not choices:
            return None
        message = choices[0].get("message") or {}

        # Shape 1: explicit images array.
        for img in message.get("images") or []:
            url = (img.get("image_url") or {}).get("url") if isinstance(img, dict) else None
            decoded = OpenRouterImageProvider._decode_data_url(url)
            if decoded:
                return decoded

        content = message.get("content")

        # Shape 2: structured content parts.
        if isinstance(content, list):
            for part in content:
                if not isinstance(part, dict):
                    continue
                if part.get("type") in ("image_url", "output_image", "image"):
                    url = (part.get("image_url") or {}).get("url") if isinstance(part.get("image_url"), dict) else part.get("url")
                    decoded = OpenRouterImageProvider._decode_data_url(url)
                    if decoded:
                        return decoded
                if part.get("type") == "text":
                    decoded = OpenRouterImageProvider._scan_text_for_data_url(part.get("text", ""))
                    if decoded:
                        return decoded

        # Shape 3: plain string content with an embedded data URL.
        if isinstance(content, str):
            return OpenRouterImageProvider._scan_text_for_data_url(content)

        return None

    @staticmethod
    def _decode_data_url(url: str | None) -> bytes | None:
        if not url or not isinstance(url, str):
            return None
        if url.startswith("data:"):
            m = _DATA_URL_RE.search(url)
            if not m:
                return None
            try:
                return base64.b64decode(m.group("b64"))
            except (binascii.Error, ValueError):
                return None
        return None

    @staticmethod
    def _scan_text_for_data_url(text: str) -> bytes | None:
        if not text:
            return None
        m = _DATA_URL_RE.search(text)
        if not m:
            return None
        try:
            return base64.b64decode(m.group("b64"))
        except (binascii.Error, ValueError):
            return None
