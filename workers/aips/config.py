"""Environment-driven configuration.

Loads from process env (and a local .env if present via python-dotenv). Env var
names mirror /Users/andersbj/Projekt/ai-ps/.env.example exactly.
"""

from __future__ import annotations

import os
from dataclasses import dataclass

from dotenv import load_dotenv

# Load .env if present; real deployment uses container env / Docker secrets.
load_dotenv()


def _get(name: str, default: str | None = None) -> str:
    val = os.environ.get(name, default)
    if val is None:
        raise RuntimeError(f"Required environment variable {name} is not set")
    return val


@dataclass(frozen=True)
class Settings:
    # --- Redis (broker, result backend, pub/sub, job store, intake list) ---
    redis_url: str

    # --- MinIO / S3 ---
    minio_endpoint: str          # host:port for the S3 API (in-cluster)
    minio_public_endpoint: str   # browser-reachable base URL (presign / public)
    minio_root_user: str
    minio_root_password: str
    minio_bucket: str
    minio_use_ssl: bool

    # --- OpenRouter ---
    openrouter_api_key: str
    openrouter_base_url: str
    openrouter_image_model: str

    # --- Optional specialist providers (Phase 3: upscale / segment) ---
    fal_key: str | None
    replicate_api_token: str | None

    # --- Postgres (reserved for the billing ledger; not used in Phase 0) ---
    database_url: str | None

    # --- Provider resilience (retry / circuit breaker / raw-output cache) ---
    #: Max RETRY attempts (beyond the first try) for transient provider failures.
    provider_max_retries: int
    #: Exponential-backoff base, in milliseconds (sleep grows base*2**attempt).
    provider_backoff_base_ms: int
    #: Hard ceiling on a single backoff sleep, in milliseconds.
    provider_backoff_max_ms: int
    #: Consecutive failures before a provider's circuit OPENS (fails fast).
    circuit_fail_threshold: int
    #: Seconds the circuit stays OPEN before allowing a single half-open probe.
    circuit_reset_seconds: int
    #: TTL for cached RAW provider output (so a post-processing retry skips re-pay).
    provider_raw_cache_ttl_seconds: int


def load_settings() -> Settings:
    return Settings(
        redis_url=_get("REDIS_URL", "redis://redis:6379/0"),
        minio_endpoint=_get("MINIO_ENDPOINT", "minio:9000"),
        minio_public_endpoint=_get("MINIO_PUBLIC_ENDPOINT", "http://localhost:9000"),
        minio_root_user=_get("MINIO_ROOT_USER", "aips"),
        minio_root_password=_get("MINIO_ROOT_PASSWORD", "aips_dev_password"),
        minio_bucket=_get("MINIO_BUCKET", "aips"),
        minio_use_ssl=_get("MINIO_USE_SSL", "false").lower() in ("1", "true", "yes"),
        openrouter_api_key=_get("OPENROUTER_API_KEY", "sk-or-v1-REPLACE_ME"),
        openrouter_base_url=_get("OPENROUTER_BASE_URL", "https://openrouter.ai/api/v1"),
        openrouter_image_model=_get(
            "OPENROUTER_IMAGE_MODEL", "google/gemini-3-pro-image-preview"
        ),
        # Optional — empty string in .env means "not configured" -> treat as None.
        fal_key=(os.environ.get("FAL_KEY") or None),
        replicate_api_token=(os.environ.get("REPLICATE_API_TOKEN") or None),
        database_url=os.environ.get("DATABASE_URL"),
        provider_max_retries=int(_get("PROVIDER_MAX_RETRIES", "4")),
        provider_backoff_base_ms=int(_get("PROVIDER_BACKOFF_BASE_MS", "500")),
        provider_backoff_max_ms=int(_get("PROVIDER_BACKOFF_MAX_MS", "15000")),
        circuit_fail_threshold=int(_get("CIRCUIT_FAIL_THRESHOLD", "5")),
        circuit_reset_seconds=int(_get("CIRCUIT_RESET_SECONDS", "30")),
        provider_raw_cache_ttl_seconds=int(_get("PROVIDER_RAW_CACHE_TTL_SECONDS", "3600")),
    )


# Module-level singleton — cheap, frozen, safe to import anywhere.
settings = load_settings()
