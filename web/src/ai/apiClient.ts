/**
 * Typed client for the @aips/api server. All wire shapes come from
 * @aips/shared-types. Keys never reach the browser; we only ever talk to our
 * own API and to presigned MinIO URLs.
 */
import type {
  CreateJobRequest,
  CreateJobResponse,
  Capability,
  Job,
  ServerWsMessage,
  ClientWsMessage,
  PresignUploadRequest,
  PresignUploadResponse,
  AssetRef,
} from "@aips/shared-types";

const API_URL: string =
  (import.meta.env.VITE_API_URL as string | undefined) ??
  "http://localhost:8080";

/** sha256 hex of bytes using SubtleCrypto. */
export async function sha256Hex(data: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/** Stable idempotency key from a logical action description. */
export async function idempotencyKey(parts: unknown): Promise<string> {
  const json = JSON.stringify(parts);
  const buf = new TextEncoder().encode(json);
  return sha256Hex(buf.buffer as ArrayBuffer);
}

async function jsonFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${API_URL}${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...(init?.headers ?? {}),
    },
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`API ${path} failed: ${res.status} ${text}`);
  }
  return (await res.json()) as T;
}

/**
 * Presign + (conditionally) upload a file to object storage, returning the
 * AssetRef other jobs can reference.
 */
export async function presignUpload(file: Blob): Promise<AssetRef> {
  const bytes = await file.arrayBuffer();
  const sha = await sha256Hex(bytes);
  const req: PresignUploadRequest = {
    sha256: sha,
    contentType: file.type || "application/octet-stream",
    byteLength: bytes.byteLength,
  };
  const presign = await jsonFetch<PresignUploadResponse>(
    "/storage/presign-upload",
    {
      method: "POST",
      body: JSON.stringify(req),
    },
  );
  if (!presign.alreadyExists && presign.uploadUrl) {
    const put = await fetch(presign.uploadUrl, {
      method: "PUT",
      headers: presign.requiredHeaders,
      body: bytes,
    });
    if (!put.ok) throw new Error(`Upload PUT failed: ${put.status}`);
  }
  return {
    key: presign.key,
    sha256: sha,
    contentType: req.contentType,
  };
}

export async function createJob<C extends Capability>(
  req: CreateJobRequest<C>,
): Promise<CreateJobResponse> {
  return jsonFetch<CreateJobResponse>("/ai/jobs", {
    method: "POST",
    body: JSON.stringify(req),
  });
}

export async function getJob(id: string): Promise<Job> {
  return jsonFetch<Job>(`/ai/jobs/${encodeURIComponent(id)}`);
}

/**
 * Open a WebSocket to the job progress relay and subscribe to a job. Calls
 * `onUpdate` for every job_update; returns a disposer that unsubscribes and
 * closes the socket.
 */
export function connectJobSocket(
  jobId: string,
  onUpdate: (job: Job) => void,
  onError?: (code: string, message: string) => void,
): () => void {
  // http(s) -> ws(s)
  const wsBase = API_URL.replace(/^http/i, "ws");
  const ws = new WebSocket(`${wsBase}/ws`);
  let closed = false;

  const send = (msg: ClientWsMessage) => {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
  };

  ws.addEventListener("open", () => send({ type: "subscribe", jobId }));
  ws.addEventListener("message", (ev) => {
    let msg: ServerWsMessage;
    try {
      msg = JSON.parse(ev.data as string) as ServerWsMessage;
    } catch {
      return;
    }
    if (msg.type === "job_update" && msg.job.id === jobId) {
      onUpdate(msg.job);
    } else if (msg.type === "error") {
      onError?.(msg.code, msg.message);
    }
  });
  ws.addEventListener("error", () => onError?.("ws_error", "WebSocket error"));

  return () => {
    if (closed) return;
    closed = true;
    send({ type: "unsubscribe", jobId });
    ws.close();
  };
}
