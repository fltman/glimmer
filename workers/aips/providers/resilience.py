"""Shared provider resilience: retry/backoff, circuit breaker, raw-output cache.

This module is the single resilience layer wrapped around every provider HTTP
entrypoint (OpenRouter `_generate`, fal `_post_sync`, Replicate `_run_prediction`).
It deliberately knows nothing about *what* a provider returns — it only operates
on a `send()` callable that either returns a value or raises the existing
`ProviderError` contract (see `providers.openrouter.ProviderError`). That keeps the
per-provider response parsing / `ProviderError` code mapping completely intact;
this layer only governs *when* and *whether* to retry, and short-circuits a dead
provider.

Three primitives
----------------
1. ``request_with_retry(send, *, provider, ...)`` — calls ``send()``; on a
   *transient* ``ProviderError`` (rate-limit / 5xx / network / timeout) it retries
   with exponential backoff + full jitter, honouring a ``Retry-After`` hint when
   the HTTP layer attached one. It FAILS FAST (re-raises immediately, no retry) on
   non-retryable codes (content policy, invalid request, auth, bad/empty response)
   because those never succeed on retry.

2. ``CircuitBreaker`` — one per provider key ("openrouter" | "fal" | "replicate").
   After ``CIRCUIT_FAIL_THRESHOLD`` consecutive transient failures it OPENS and
   rejects calls immediately with ``ProviderError("provider_circuit_open", ...)``
   for ``CIRCUIT_RESET_SECONDS``; then it allows ONE half-open probe — success
   closes it, failure re-opens it. State is **process-local** (a module-level dict
   guarded by a lock). That is intentional and sufficient here: each Celery worker
   process protects *itself* from hammering a dead provider; we accept that N
   worker processes can independently trip rather than taking a hard dependency on
   a shared Redis breaker (which would add a failure mode of its own). Document &
   tune via ``CIRCUIT_FAIL_THRESHOLD`` / ``CIRCUIT_RESET_SECONDS``.

3. ``get_or_call(cache_key, produce)`` — a Redis-backed cache for *raw paid
   provider output*. The expensive, billed step is the provider image bytes;
   post-processing (color-match / feather / composite / tiling / normalize) is
   local and may itself fail or be retried (Celery ``task_acks_late`` redelivers a
   task whose worker died mid-run). Caching the raw bytes keyed by the full call
   signature means a redelivered / retried task re-reads the already-paid bytes
   instead of re-billing the provider. The cached entry also records the original
   ``cost_usd`` so the task only bills it ONCE: a cache *hit* reports cost 0.

All cache operations degrade gracefully — any Redis error is swallowed and treated
as a miss / no-store, so the cache can never break a task.
"""

from __future__ import annotations

import hashlib
import json
import logging
import random
import threading
import time
from dataclasses import dataclass
from typing import Callable, TypeVar

from ..config import settings
from .openrouter import ProviderError

log = logging.getLogger("aips.providers.resilience")

T = TypeVar("T")

# ── Retry classification ──────────────────────────────────────────────────────
# Transient ProviderError codes worth retrying (server-side / network hiccups).
RETRYABLE_CODES: frozenset[str] = frozenset(
    {
        "provider_rate_limited",   # 429
        "provider_unavailable",    # 5xx
        "provider_network_error",  # connection reset / DNS / TLS
        "provider_timeout",        # poll / read timeout
        "provider_error",          # generic non-2xx we couldn't classify better
    }
)

# Codes that must NEVER be retried (a retry can only waste money / time):
#   content_policy        — model refused; identical input refuses again
#   provider_bad_request  — 400/422 malformed request
#   provider_auth_error   — 401 bad key
#   no_*_provider         — nothing configured
#   invalid_inputs        — caller bug
#   no_image_in_response / provider_bad_response / decode_failed — deterministic
# Anything NOT in RETRYABLE_CODES is treated as fail-fast.


def _is_retryable(code: str) -> bool:
    return code in RETRYABLE_CODES


# ── Retry-After plumbing ──────────────────────────────────────────────────────
def attach_retry_after(exc: ProviderError, retry_after: float | None) -> ProviderError:
    """Annotate a ProviderError with a server-provided Retry-After (seconds).

    The HTTP layers call this before raising a 429/503 so the retry loop can honour
    the provider's pacing instead of guessing. Tolerates being given the raw header
    value (seconds-as-string, or an HTTP-date) and parses it.
    """
    exc.retry_after = parse_retry_after(retry_after)  # type: ignore[attr-defined]
    return exc


def parse_retry_after(value: object) -> float | None:
    """Parse a Retry-After header value to seconds, or return None.

    Accepts an int/float seconds value, a numeric string ("12"), or an HTTP-date
    ("Wed, 21 Oct 2025 07:28:00 GMT"); anything unparseable yields None.
    """
    if value is None:
        return None
    if isinstance(value, (int, float)):
        return max(0.0, float(value))
    if not isinstance(value, str):
        return None
    s = value.strip()
    if not s:
        return None
    try:
        return max(0.0, float(s))
    except ValueError:
        pass
    # HTTP-date form → seconds from now.
    try:
        from email.utils import parsedate_to_datetime

        dt = parsedate_to_datetime(s)
        if dt is None:
            return None
        delta = dt.timestamp() - time.time()
        return max(0.0, delta)
    except (TypeError, ValueError, OverflowError):
        return None


def _backoff_seconds(attempt: int, retry_after: float | None) -> float:
    """Exponential backoff with full jitter, never below an honoured Retry-After.

    base*2**attempt capped at PROVIDER_BACKOFF_MAX_MS, then multiplied by a random
    factor in [0.5, 1.0] (full jitter, lower-bounded so we still make progress). If
    the provider sent a Retry-After, we wait at least that long.
    """
    base_ms = settings.provider_backoff_base_ms
    max_ms = settings.provider_backoff_max_ms
    raw_ms = min(max_ms, base_ms * (2 ** attempt))
    jittered = (raw_ms * (0.5 + 0.5 * random.random())) / 1000.0
    if retry_after is not None:
        # Honour the server's pacing, but never exceed the configured ceiling by
        # an unbounded amount — clamp an absurd Retry-After to max_ms*4.
        return max(jittered, min(retry_after, (max_ms / 1000.0) * 4))
    return jittered


# ── Circuit breaker (process-local) ───────────────────────────────────────────
@dataclass
class _BreakerState:
    failures: int = 0
    opened_at: float | None = None  # monotonic time the circuit OPENED
    half_open: bool = False         # a probe is in flight


class CircuitBreaker:
    """Per-provider consecutive-failure breaker. Process-local, thread-safe.

    Lifecycle:
      CLOSED  → every transient failure increments ``failures``; at the threshold
                the circuit OPENS.
      OPEN    → calls are rejected immediately (``provider_circuit_open``) until
                ``reset_seconds`` have elapsed, then the next call is allowed
                through as a single HALF-OPEN probe.
      HALF    → the probe's success CLOSES the circuit (counters reset); its
                failure RE-OPENS it (timer restarts).

    Only *transient* failures count toward opening — a fail-fast error (content
    policy / bad request) is a property of the request, not provider health, so it
    neither opens nor closes the breaker.
    """

    def __init__(self, key: str, *, fail_threshold: int | None = None, reset_seconds: int | None = None):
        self.key = key
        self.fail_threshold = fail_threshold if fail_threshold is not None else settings.circuit_fail_threshold
        self.reset_seconds = reset_seconds if reset_seconds is not None else settings.circuit_reset_seconds
        self._state = _BreakerState()
        self._lock = threading.Lock()

    def before_call(self) -> None:
        """Raise ``provider_circuit_open`` if the circuit is OPEN and cooling down."""
        with self._lock:
            st = self._state
            if st.opened_at is None:
                return  # CLOSED
            elapsed = time.monotonic() - st.opened_at
            if elapsed < self.reset_seconds:
                if st.half_open:
                    # A probe is already in flight; reject concurrent callers.
                    raise ProviderError(
                        "provider_circuit_open",
                        f"{self.key} circuit open (probe in flight)",
                    )
                raise ProviderError(
                    "provider_circuit_open",
                    f"{self.key} circuit open; retry in "
                    f"{self.reset_seconds - elapsed:.0f}s",
                )
            # Cooldown elapsed → allow ONE half-open probe.
            st.half_open = True

    def on_success(self) -> None:
        with self._lock:
            self._state = _BreakerState()  # fully reset → CLOSED

    def on_failure(self) -> None:
        """Record a transient failure; open (or re-open) the circuit at threshold."""
        with self._lock:
            st = self._state
            if st.half_open:
                # Probe failed → re-open immediately, restart the timer.
                st.opened_at = time.monotonic()
                st.half_open = False
                st.failures = self.fail_threshold
                log.warning("circuit %s re-opened after failed probe", self.key)
                return
            st.failures += 1
            if st.failures >= self.fail_threshold and st.opened_at is None:
                st.opened_at = time.monotonic()
                log.warning(
                    "circuit %s OPENED after %d consecutive failures",
                    self.key,
                    st.failures,
                )

    def is_open(self) -> bool:
        with self._lock:
            st = self._state
            if st.opened_at is None:
                return False
            return (time.monotonic() - st.opened_at) < self.reset_seconds


# Module-level registry so one breaker per provider key is shared across every
# call site in this process.
_BREAKERS: dict[str, CircuitBreaker] = {}
_BREAKERS_LOCK = threading.Lock()


def get_breaker(provider: str) -> CircuitBreaker:
    with _BREAKERS_LOCK:
        b = _BREAKERS.get(provider)
        if b is None:
            b = CircuitBreaker(provider)
            _BREAKERS[provider] = b
        return b


def reset_breakers() -> None:
    """Reset all breakers (used by tests; harmless in production)."""
    with _BREAKERS_LOCK:
        _BREAKERS.clear()


# ── The retry wrapper ─────────────────────────────────────────────────────────
def request_with_retry(
    send: Callable[[], T],
    *,
    provider: str,
    max_retries: int | None = None,
) -> T:
    """Run ``send()`` with retry/backoff + per-provider circuit breaking.

    ``send`` does one full provider attempt and either returns its value or raises
    ``ProviderError`` (or any other exception). Behaviour:

    - The circuit is checked BEFORE each attempt; if OPEN, we fail fast with
      ``provider_circuit_open`` (no HTTP call, no sleep).
    - A non-retryable ``ProviderError`` (or non-ProviderError exception) is
      re-raised immediately and does NOT count against the breaker.
    - A retryable ``ProviderError`` counts against the breaker and triggers a
      backoff sleep (honouring an attached ``retry_after``) before the next
      attempt, until ``max_retries`` is exhausted, after which it is re-raised.
    """
    retries = settings.provider_max_retries if max_retries is None else max_retries
    breaker = get_breaker(provider)

    attempt = 0
    while True:
        # Circuit gate (raises provider_circuit_open if open & cooling down).
        breaker.before_call()
        try:
            result = send()
        except ProviderError as exc:
            if not _is_retryable(exc.code):
                # Deterministic failure — do not retry, do not trip the breaker.
                raise
            breaker.on_failure()
            if attempt >= retries:
                log.warning(
                    "provider %s exhausted %d retries (last code=%s): %s",
                    provider,
                    retries,
                    exc.code,
                    exc.message,
                )
                raise
            retry_after = getattr(exc, "retry_after", None)
            sleep_s = _backoff_seconds(attempt, retry_after)
            log.info(
                "provider %s transient failure (code=%s) attempt %d/%d; "
                "retrying in %.2fs",
                provider,
                exc.code,
                attempt + 1,
                retries,
                sleep_s,
            )
            time.sleep(sleep_s)
            attempt += 1
            continue
        except Exception:  # noqa: BLE001
            # Unexpected (non-ProviderError) failure: do not retry blindly and do
            # not trip the breaker — let the task's own handler classify it.
            raise
        else:
            breaker.on_success()
            return result


# ── Raw provider-output cache (Redis-backed, paid step only) ──────────────────
@dataclass
class CachedOutput:
    """A cached raw provider result plus the billing already paid for it.

    ``cost_usd`` is the ORIGINAL cost charged when the bytes were first produced.
    On a cache HIT the caller records cost 0 (already billed) but can still surface
    ``model`` for ``providerResolved``.
    """

    data: bytes
    cost_usd: float | None
    model: str | None
    cached: bool  # True when this came from cache (→ bill 0), False on first call


def make_cache_key(*, capability: str, model: str, parts: list[object]) -> str:
    """Stable cache key for a paid provider call.

    The key MUST capture everything that changes the output: capability, model,
    every input image (by sha256 of its bytes), the prompt/instruction, and the
    seed. ``parts`` is hashed in order; ``bytes`` entries are hashed by content so
    large images don't bloat the key.
    """
    h = hashlib.sha256()
    h.update(capability.encode("utf-8"))
    h.update(b"\x00")
    h.update(model.encode("utf-8"))
    for part in parts:
        h.update(b"\x00")
        if isinstance(part, bytes):
            h.update(hashlib.sha256(part).digest())
        elif part is None:
            h.update(b"\x01none")
        else:
            h.update(str(part).encode("utf-8"))
    return "aips:rawcache:" + h.hexdigest()


def _redis():
    """Lazily import the worker Redis client; None if Redis is unavailable.

    Imported lazily (not at module load) so this module compiles and imports even
    where the ``redis`` package isn't installed (e.g. a lint/compile-only env).
    """
    try:
        from ..redis_io import get_client

        return get_client()
    except Exception:  # noqa: BLE001
        return None


def get_or_call(
    cache_key: str,
    produce: Callable[[], CachedOutput],
    *,
    ttl_seconds: int | None = None,
) -> CachedOutput:
    """Return cached raw output for ``cache_key`` or produce + cache it.

    ``produce`` performs the actual (paid) provider call and returns a
    ``CachedOutput`` with ``cached=False`` and the real ``cost_usd``. On a HIT the
    returned object has ``cached=True`` and ``cost_usd`` taken from the stored
    entry — callers should bill 0 for a hit to avoid double-charging.

    Any Redis error (read or write) is swallowed: a read failure is a miss (we just
    call ``produce``), a write failure leaves the result uncached. Caching never
    breaks a task.
    """
    ttl = settings.provider_raw_cache_ttl_seconds if ttl_seconds is None else ttl_seconds
    client = _redis()

    if client is not None:
        try:
            meta_raw = client.hget(cache_key, "meta")
            data_raw = client.hget(cache_key, "data_b64")
            if meta_raw and data_raw:
                import base64

                meta = json.loads(meta_raw)
                data = base64.b64decode(data_raw)
                log.info("raw-cache HIT key=%s (billing 0, already paid)", cache_key[-12:])
                return CachedOutput(
                    data=data,
                    cost_usd=meta.get("cost_usd"),
                    model=meta.get("model"),
                    cached=True,
                )
        except Exception:  # noqa: BLE001
            log.debug("raw-cache read failed for %s; treating as miss", cache_key[-12:])

    produced = produce()

    if client is not None and produced.data:
        try:
            import base64

            client.hset(
                cache_key,
                mapping={
                    "data_b64": base64.b64encode(produced.data).decode("ascii"),
                    "meta": json.dumps(
                        {"cost_usd": produced.cost_usd, "model": produced.model}
                    ),
                },
            )
            client.expire(cache_key, ttl)
        except Exception:  # noqa: BLE001
            log.debug("raw-cache write failed for %s; result left uncached", cache_key[-12:])

    return produced
