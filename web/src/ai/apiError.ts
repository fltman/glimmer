/**
 * Shared API error type + a tiny global "auth/credit problem" surface.
 *
 * Every API client (apiClient, agentClient, analyzeClient) throws an `ApiError`
 * carrying the HTTP status, the stable machine `code` from the JSON envelope,
 * and — for the structured billing/rate-limit envelopes — the extra fields the
 * UI cares about (required / balance / retryAfterSeconds).
 *
 * Because the 11 capabilities + 2 sync endpoints each surface their own errors
 * in-place, this module ALSO offers a cheap global notice channel: when an API
 * call hits 402 (insufficient credits) or 429 (rate limited) or 401
 * (unauthorized), the client emits a structured notice that the account widget
 * renders as a banner. Per-section error text is untouched; this is purely an
 * additive, shared affordance so the user always learns WHY a call failed and
 * what to do (top up / wait), no matter which tab they're on.
 */
import type {
  InsufficientCreditsResponse,
  RateLimitedResponse,
} from "@aips/shared-types";
import { clearSession, resetBoot } from "./auth";

export type ApiNoticeKind = "insufficient_credits" | "rate_limited" | "unauthorized";

export interface ApiNotice {
  kind: ApiNoticeKind;
  message: string;
  /** insufficient_credits: credits the op required. */
  required?: number;
  /** insufficient_credits: the user's current balance. */
  balance?: number;
  /** rate_limited: seconds to wait. */
  retryAfterSeconds?: number;
  at: number;
}

/** Structured error thrown by every API client on a non-2xx response. */
export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly required?: number;
  readonly balance?: number;
  readonly retryAfterSeconds?: number;

  constructor(
    status: number,
    code: string,
    message: string,
    extra?: {
      required?: number;
      balance?: number;
      retryAfterSeconds?: number;
    },
  ) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.required = extra?.required;
    this.balance = extra?.balance;
    this.retryAfterSeconds = extra?.retryAfterSeconds;
  }
}

const noticeListeners = new Set<(n: ApiNotice) => void>();

/** Subscribe to global API notices (402/429/401). Returns an unsubscribe fn. */
export function subscribeApiNotice(fn: (n: ApiNotice) => void): () => void {
  noticeListeners.add(fn);
  return () => noticeListeners.delete(fn);
}

function emitNotice(n: ApiNotice): void {
  for (const l of noticeListeners) l(n);
}

/**
 * Parse a failed `Response` into an `ApiError`, reading the stable `{error,...}`
 * envelope when present, and emit the matching global notice for the billing /
 * rate-limit / auth cases. Falls back gracefully to status text for non-JSON
 * bodies (a crashed proxy, etc.).
 */
export async function errorFromResponse(
  res: Response,
  path: string,
): Promise<ApiError> {
  let body: Record<string, unknown> | null = null;
  let raw = "";
  try {
    body = (await res.clone().json()) as Record<string, unknown>;
  } catch {
    raw = await res.text().catch(() => "");
  }

  const code =
    (typeof body?.error === "string" && body.error) ||
    (typeof body?.code === "string" && (body.code as string)) ||
    `http_${res.status}`;
  const message =
    (typeof body?.message === "string" && body.message) ||
    raw ||
    `API ${path} failed: ${res.status}`;

  // Pull the structured extras for billing / rate-limit envelopes.
  let required: number | undefined;
  let balance: number | undefined;
  let retryAfterSeconds: number | undefined;

  if (res.status === 402 && body && body.error === "insufficient_credits") {
    const b = body as unknown as InsufficientCreditsResponse;
    required = b.required;
    balance = b.balance;
    emitNotice({
      kind: "insufficient_credits",
      message,
      required,
      balance,
      at: Date.now(),
    });
  } else if (res.status === 429) {
    const b = body as unknown as Partial<RateLimitedResponse>;
    retryAfterSeconds =
      typeof b.retryAfterSeconds === "number"
        ? b.retryAfterSeconds
        : Number(res.headers.get("Retry-After")) || undefined;
    emitNotice({
      kind: "rate_limited",
      message,
      retryAfterSeconds,
      at: Date.now(),
    });
  } else if (res.status === 401) {
    // Token absent/expired/invalid — drop it so the next boot re-mints (dev) or
    // a real login is required (prod). Reset the once-guard so a retry can run.
    clearSession();
    resetBoot();
    emitNotice({ kind: "unauthorized", message, at: Date.now() });
  }

  return new ApiError(res.status, code, message, {
    required,
    balance,
    retryAfterSeconds,
  });
}
