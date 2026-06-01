/**
 * Typed client for POST /ai/agent — the synchronous TEXT planner endpoint.
 *
 * The browser POSTs { goal, context? } and receives a validated { plan }. The
 * provider key never reaches the browser; we only ever talk to our own API
 * (same origin/base as the job API in apiClient.ts).
 *
 * This is intentionally separate from the async job client (apiClient.ts):
 * /ai/agent is a one-shot request/response (no WebSocket, no queue), so it has
 * its own tiny fetch wrapper that surfaces the documented error envelopes.
 */
import type { AgentRequest, AgentResponse } from "@aips/shared-types";
import { API_URL, authHeaders } from "../auth";
import { errorFromResponse } from "../apiError";

/** A structured failure from the planner endpoint (4xx/5xx envelopes). */
export class AgentRequestError extends Error {
  /** Machine-readable code: "invalid_request" | provider_* | planner_* | http_* */
  readonly code: string;
  /** HTTP status, when the failure came back as a response. */
  readonly status?: number;
  constructor(code: string, message: string, status?: number) {
    super(message);
    this.name = "AgentRequestError";
    this.code = code;
    this.status = status;
  }
}

/**
 * Ask the planner to turn a natural-language goal (+ optional editor context)
 * into an executable AgentPlan. Resolves with the validated plan, or throws an
 * AgentRequestError describing the documented failure envelope.
 */
export async function requestPlan(req: AgentRequest): Promise<AgentResponse> {
  let res: Response;
  try {
    res = await fetch(`${API_URL}/ai/agent`, {
      method: "POST",
      headers: authHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify(req),
    });
  } catch (e) {
    // Network-level failure reaching our own API (offline, CORS, DNS).
    throw new AgentRequestError(
      "network_error",
      e instanceof Error ? e.message : "Failed to reach the planner.",
    );
  }

  if (!res.ok) {
    // Side effect only: emit the shared 402/429/401 notice (and clear a stale
    // session on 401) so the credit/rate-limit banner appears no matter which
    // tab the user is on. We still throw the AgentRequestError below so the
    // assistant's own per-code error handling is preserved.
    if (res.status === 402 || res.status === 429 || res.status === 401) {
      void errorFromResponse(res, "/ai/agent");
    }
    // The API returns { error, issues } (400) or { error, message } (502).
    // Parse defensively — a proxy or crash could return non-JSON.
    let body: unknown = null;
    try {
      body = await res.json();
    } catch {
      const text = await res.text().catch(() => "");
      throw new AgentRequestError(
        `http_${res.status}`,
        text || `Planner request failed (${res.status}).`,
        res.status,
      );
    }
    const b = body as { error?: string; message?: string; issues?: unknown };
    const code = typeof b.error === "string" ? b.error : `http_${res.status}`;
    const message =
      typeof b.message === "string"
        ? b.message
        : code === "invalid_request"
          ? "The planner rejected the request."
          : `Planner request failed (${res.status}).`;
    throw new AgentRequestError(code, message, res.status);
  }

  return (await res.json()) as AgentResponse;
}
