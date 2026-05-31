/**
 * Object storage (MinIO via the S3 API).
 *
 * The S3 client targets the *internal* MINIO_ENDPOINT for server-side calls
 * (HeadObject etc.), but presigned URLs handed to the browser must use the
 * *public* endpoint. We achieve that by signing against a client configured
 * with the public endpoint — the signature is bound to host+path, so it must
 * match the host the browser will hit.
 */
import {
  HeadObjectCommand,
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { config } from "./config.js";

const { minio } = config;

function endpointUrl(hostPort: string, useSsl: boolean): string {
  // MINIO_ENDPOINT is `host:port`; MINIO_PUBLIC_ENDPOINT is already a URL.
  if (/^https?:\/\//.test(hostPort)) return hostPort;
  return `${useSsl ? "https" : "http"}://${hostPort}`;
}

const credentials = {
  accessKeyId: minio.accessKey,
  secretAccessKey: minio.secretKey,
};

/** Client for server-side operations against the internal endpoint. */
const internalClient = new S3Client({
  region: "us-east-1", // MinIO ignores region but the SDK requires one
  endpoint: endpointUrl(minio.endpoint, minio.useSsl),
  forcePathStyle: true,
  credentials,
});

/**
 * Client used solely to produce presigned URLs for the browser; bound to the
 * public endpoint so the signed host matches what the client requests.
 */
const publicClient = new S3Client({
  region: "us-east-1",
  endpoint: minio.publicEndpoint,
  forcePathStyle: true,
  credentials,
});

const PRESIGN_EXPIRY_SECONDS = 60 * 15; // 15 minutes

/** Presign a PUT for the browser to upload bytes directly to MinIO. */
export async function presignPut(
  key: string,
  contentType: string,
): Promise<string> {
  const cmd = new PutObjectCommand({
    Bucket: minio.bucket,
    Key: key,
    ContentType: contentType,
  });
  return getSignedUrl(publicClient, cmd, {
    expiresIn: PRESIGN_EXPIRY_SECONDS,
  });
}

/** Presign a GET so the browser (or a provider) can download an object. */
export async function presignGet(key: string): Promise<string> {
  const cmd = new GetObjectCommand({ Bucket: minio.bucket, Key: key });
  return getSignedUrl(publicClient, cmd, {
    expiresIn: PRESIGN_EXPIRY_SECONDS,
  });
}

/** Whether an object already exists (content-addressed dedup check). */
export async function objectExists(key: string): Promise<boolean> {
  try {
    await internalClient.send(
      new HeadObjectCommand({ Bucket: minio.bucket, Key: key }),
    );
    return true;
  } catch (err: unknown) {
    const e = err as { name?: string; $metadata?: { httpStatusCode?: number } };
    if (e?.name === "NotFound" || e?.$metadata?.httpStatusCode === 404) {
      return false;
    }
    throw err;
  }
}

/**
 * Content-addressed key: `u/<userId>/<sha256>.<ext>`. Dedup falls out of the
 * sha256 component — identical bytes from any user map to the same hash but we
 * namespace by user so deletes/quota stay per-user.
 */
export function buildKey(userId: string, sha256: string, ext: string): string {
  const clean = ext.replace(/^\./, "");
  return `u/${userId}/${sha256}.${clean}`;
}
