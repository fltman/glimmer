/**
 * Typed client for the account / credits / billing endpoints. Every call is
 * authenticated via the shared bearer token (see auth.ts) and surfaces the
 * structured ApiError envelope (see apiError.ts) on failure.
 *
 * No secret ever enters the bundle: the web only reads credit *counts* and a
 * static credit-pack list. The admin grant path is a dev/self-host affordance —
 * in dev mode an isAdmin JWT (the dev-user) is accepted by the API, so no admin
 * token is shipped here; the button simply hits the endpoint with the bearer
 * token and the server authorizes it.
 */
import type {
  MeResponse,
  AccountResponse,
  BalanceResponse,
  UsageResponse,
  GrantCreditsRequest,
  GrantCreditsResponse,
  BillingPacksResponse,
} from "@aips/shared-types";
import { API_URL, authHeaders } from "./auth";
import { errorFromResponse } from "./apiError";

async function getJson<T>(path: string): Promise<T> {
  const res = await fetch(`${API_URL}${path}`, {
    method: "GET",
    headers: authHeaders(),
  });
  if (!res.ok) throw await errorFromResponse(res, path);
  return (await res.json()) as T;
}

async function postJson<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(`${API_URL}${path}`, {
    method: "POST",
    headers: authHeaders({ "Content-Type": "application/json" }),
    body: JSON.stringify(body),
  });
  if (!res.ok) throw await errorFromResponse(res, path);
  return (await res.json()) as T;
}

/** GET /auth/me — identity + live balance. */
export function fetchMe(): Promise<MeResponse> {
  return getJson<MeResponse>("/auth/me");
}

/** GET /account — balance + recent usage history. */
export function fetchAccount(): Promise<AccountResponse> {
  return getJson<AccountResponse>("/account");
}

/** GET /account/balance — lightweight poll after each job/sync call. */
export function fetchBalance(): Promise<BalanceResponse> {
  return getJson<BalanceResponse>("/account/balance");
}

/** GET /account/usage — the last-N billed entries. */
export function fetchUsage(): Promise<UsageResponse> {
  return getJson<UsageResponse>("/account/usage");
}

/** GET /billing/packs — purchasable credit bundles + whether Stripe is live. */
export function fetchBillingPacks(): Promise<BillingPacksResponse> {
  return getJson<BillingPacksResponse>("/billing/packs");
}

/**
 * POST /admin/credits/grant — dev/self-host top-up. In dev the dev-user's JWT
 * is treated as admin by the API, so the bearer token alone authorizes this.
 */
export function grantCredits(
  req: GrantCreditsRequest,
): Promise<GrantCreditsResponse> {
  return postJson<GrantCreditsResponse>("/admin/credits/grant", req);
}
