"""MinIO (S3-compatible) object storage via boto3.

Workers store artifacts here; the API presigns GET URLs for the browser. For
Phase 0 echo we can also build a public URL via MINIO_PUBLIC_ENDPOINT.

Keys are content-addressed: `u/<userId>/<sha256>.<ext>` so identical bytes dedup.
"""

from __future__ import annotations

import hashlib
from functools import lru_cache

import boto3
from botocore.client import Config
from botocore.exceptions import ClientError

from .config import settings


def _make_client(endpoint_url: str):
    return boto3.client(
        "s3",
        endpoint_url=endpoint_url,
        aws_access_key_id=settings.minio_root_user,
        aws_secret_access_key=settings.minio_root_password,
        # MinIO requires path-style addressing and a region (any value).
        config=Config(signature_version="s3v4", s3={"addressing_style": "path"}),
        region_name="us-east-1",
    )


@lru_cache(maxsize=1)
def get_s3():
    """Process-wide boto3 S3 client pointed at the in-cluster MinIO endpoint."""
    scheme = "https" if settings.minio_use_ssl else "http"
    endpoint_url = f"{scheme}://{settings.minio_endpoint}"
    return _make_client(endpoint_url)


@lru_cache(maxsize=1)
def get_s3_public():
    """Client bound to the PUBLIC endpoint, used solely for presigning browser
    URLs. We sign against the public host directly (mirrors the API's
    publicClient) so the SigV4 signature is valid for the host the browser hits —
    naive post-signing host rewriting would invalidate the signature."""
    return _make_client(settings.minio_public_endpoint.rstrip("/"))


def ensure_bucket() -> None:
    """Create the configured bucket if it does not yet exist (idempotent)."""
    s3 = get_s3()
    try:
        s3.head_bucket(Bucket=settings.minio_bucket)
    except ClientError:
        try:
            s3.create_bucket(Bucket=settings.minio_bucket)
        except ClientError:
            # Lost a race or already exists — fine.
            pass


def sha256_hex(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def build_key(user_id: str, sha256: str, ext: str) -> str:
    """Content-addressed object key: `u/<userId>/<sha256>.<ext>`."""
    ext = ext.lstrip(".")
    return f"u/{user_id}/{sha256}.{ext}"


def object_exists(key: str) -> bool:
    try:
        get_s3().head_object(Bucket=settings.minio_bucket, Key=key)
        return True
    except ClientError:
        return False


def download_object(key: str) -> bytes:
    """Fetch object bytes by key."""
    obj = get_s3().get_object(Bucket=settings.minio_bucket, Key=key)
    return obj["Body"].read()


def upload_bytes(key: str, data: bytes, content_type: str) -> str:
    """Upload bytes under `key`. Returns the key. Idempotent for identical keys."""
    get_s3().put_object(
        Bucket=settings.minio_bucket,
        Key=key,
        Body=data,
        ContentType=content_type,
    )
    return key


def presign_get(key: str, expires_seconds: int = 3600) -> str:
    """Presigned GET URL signed against the PUBLIC endpoint so a browser outside
    the Docker network can fetch it with a valid SigV4 signature."""
    return get_s3_public().generate_presigned_url(
        "get_object",
        Params={"Bucket": settings.minio_bucket, "Key": key},
        ExpiresIn=expires_seconds,
    )


def public_url(key: str) -> str:
    """Unsigned public URL (only works if the bucket/object is publicly readable)."""
    base = settings.minio_public_endpoint.rstrip("/")
    return f"{base}/{settings.minio_bucket}/{key}"
