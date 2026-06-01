/**
 * Typed client for the SYNCHRONOUS distraction-finder endpoint
 * (POST /ai/analyze-distractions). This mirrors the synchronous /ai/agent
 * planner call, NOT the async job queue: the API downloads the image bytes
 * server-side, sends them to the multimodal text model, and returns candidate
 * regions directly in the response.
 *
 * The provider key never reaches the browser — we only ever talk to our own API
 * (and, when uploading, to presigned MinIO URLs via `presignUpload`).
 *
 * Coordinate convention: each region's `box` is in NORMALIZED [0,1] image
 * coordinates (origin top-left). The caller multiplies by the image's pixel
 * dimensions to seed a marquee.
 */
import type {
  AssetRef,
  AnalyzeDistractionsRequest,
  AnalyzeDistractionsResponse,
  DistractionRegion,
} from "@aips/shared-types";
import { API_URL, authHeaders } from "../auth";
import { errorFromResponse } from "../apiError";

/**
 * A typed error thrown when the analyzer endpoint fails. `status` is the HTTP
 * status (e.g. 502 for storage/provider/analyzer failures, 413 too large), and
 * `code` is the stable machine code from the API body when present (e.g.
 * "storage_error", "analyzer_failed", "analyzer_bad_output", "image_too_large").
 */
export class AnalyzeDistractionsError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = "AnalyzeDistractionsError";
    this.status = status;
    this.code = code;
  }
}

/** Result of an analyze call: the flagged regions plus the optional note. */
export interface AnalyzeResult {
  distractions: DistractionRegion[];
  message?: string;
}

/**
 * POST an already-uploaded image (an AssetRef from `presignUpload`) to the
 * analyzer and return the flagged regions. Throws `AnalyzeDistractionsError`
 * on any non-2xx response (502 storage/provider/analyzer, 413 too large, 400
 * bad request).
 */
export async function analyzeDistractions(
  image: AssetRef,
): Promise<AnalyzeResult> {
  const body: AnalyzeDistractionsRequest = { image };
  const res = await fetch(`${API_URL}/ai/analyze-distractions`, {
    method: "POST",
    headers: authHeaders({ "Content-Type": "application/json" }),
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    // Side effect only: surface the shared credit/rate-limit/auth banner. The
    // typed AnalyzeDistractionsError below is still thrown for the section's own
    // handling.
    if (res.status === 402 || res.status === 429 || res.status === 401) {
      void errorFromResponse(res, "/ai/analyze-distractions");
    }
    // Try to surface the API's stable {error/code, message} body; fall back to
    // the raw text + status when it isn't JSON.
    let code = "analyzer_failed";
    let message = `Analyze failed: ${res.status}`;
    try {
      const data = (await res.json()) as {
        error?: string;
        code?: string;
        message?: string;
      };
      code = data.code ?? data.error ?? code;
      message = data.message ?? message;
    } catch {
      const text = await res.text().catch(() => "");
      if (text) message = `${message} ${text}`;
    }
    throw new AnalyzeDistractionsError(res.status, code, message);
  }

  const data = (await res.json()) as AnalyzeDistractionsResponse;
  return {
    distractions: Array.isArray(data.distractions) ? data.distractions : [],
    message: data.message,
  };
}
