/**
 * Client-side auth/session store for the @aips/api server.
 *
 * The API is auth-protected (JWT). Tokens are minted SERVER-SIDE only — the JWT
 * secret, provider keys and DB creds NEVER reach the browser. The web client
 * only ever holds an opaque, server-minted, per-user token. It attaches that
 * token as `Authorization: Bearer <token>` on every API request, and as
 * `?token=<token>` on the WebSocket upgrade URL (the browser WS API cannot set
 * request headers).
 *
 * Self-host / dev frictionlessness: on first boot (when no token is stored) the
 * client transparently mints one via POST /auth/dev-login — an OPEN endpoint
 * that exists only when AUTH_DEV_MODE=true. That call ALSO seeds the dev-user's
 * credit grant server-side, so the app "just works" with no login. In
 * production (dev-login returns 403) the app falls back to surfacing an
 * auth-required state and the rest of the API simply 401s until a real login
 * flow exists.
 *
 * This module is framework-free (no React) so apiClient/agentClient/analyzeClient
 * can import it without a dependency cycle. The account UI subscribes via
 * `subscribeAuth`.
 */
import type { DevLoginRequest, DevLoginResponse } from "@aips/shared-types";

export const API_URL: string =
  (import.meta.env.VITE_API_URL as string | undefined) ??
  "http://localhost:8080";

const TOKEN_STORAGE_KEY = "aips.auth.token";

/** Public identity snapshot the account UI renders. */
export interface AuthState {
  token: string | null;
  userId: string | null;
  /** True once we've attempted to obtain a token (dev-login or restore). */
  ready: boolean;
  /** Set when dev-login is unavailable (prod) or auth otherwise failed. */
  authError: string | null;
}

let state: AuthState = {
  token: readStoredToken(),
  userId: null,
  ready: false,
  authError: null,
};

const listeners = new Set<(s: AuthState) => void>();

function readStoredToken(): string | null {
  try {
    return localStorage.getItem(TOKEN_STORAGE_KEY);
  } catch {
    return null;
  }
}

function writeStoredToken(token: string | null): void {
  try {
    if (token) localStorage.setItem(TOKEN_STORAGE_KEY, token);
    else localStorage.removeItem(TOKEN_STORAGE_KEY);
  } catch {
    // Storage unavailable (private mode etc.) — the in-memory token still works
    // for the session.
  }
}

function setState(patch: Partial<AuthState>): void {
  state = { ...state, ...patch };
  for (const l of listeners) l(state);
}

/** Current immutable auth snapshot. */
export function getAuthState(): AuthState {
  return state;
}

/** Subscribe to auth-state changes; returns an unsubscribe fn. */
export function subscribeAuth(fn: (s: AuthState) => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** The raw bearer token, or null if we don't have one yet. */
export function getAuthToken(): string | null {
  return state.token;
}

/**
 * Headers to merge into every API fetch. Includes the bearer token when present
 * and the supplied content type (defaults to JSON). In the frictionless no-token
 * window before dev-login resolves, the header is simply omitted — the dev API
 * accepts a missing token as the dev-user.
 */
export function authHeaders(
  extra?: Record<string, string>,
): Record<string, string> {
  const h: Record<string, string> = { ...extra };
  if (state.token) h["Authorization"] = `Bearer ${state.token}`;
  return h;
}

/**
 * Turn an API path into a ws/wss URL with the auth token appended as a query
 * param. The browser WebSocket API can't set headers, so the token rides on the
 * URL; the API authenticates the upgrade from `?token=`.
 */
export function wsUrlWithToken(path: string): string {
  const wsBase = API_URL.replace(/^http/i, "ws");
  const url = new URL(`${wsBase}${path}`);
  if (state.token) url.searchParams.set("token", state.token);
  return url.toString();
}

/** Persist a freshly-minted token + identity (e.g. after dev-login). */
export function setSession(token: string, userId: string): void {
  writeStoredToken(token);
  setState({ token, userId, ready: true, authError: null });
}

/** Drop the session (e.g. on a 401) so the next boot re-mints. */
export function clearSession(): void {
  writeStoredToken(null);
  setState({ token: null, userId: null, authError: null });
}

let bootPromise: Promise<void> | null = null;

/**
 * Ensure we hold a usable token before the first API call. Idempotent and
 * safe to call concurrently — the work happens once.
 *
 * - If a token is already stored, trust it (it's validated on the next real
 *   call; a 401 will clear it and a subsequent boot re-mints).
 * - Otherwise POST /auth/dev-login to mint one (dev/self-host). This also seeds
 *   the dev-user's credit grant, which the first job REQUIRES.
 * - If dev-login is unavailable (403 in prod), record an authError but don't
 *   throw — the app stays mounted; protected calls will 401 until a real login
 *   exists.
 */
export function ensureDevToken(userId?: string): Promise<void> {
  if (bootPromise) return bootPromise;
  bootPromise = (async () => {
    if (state.token) {
      setState({ ready: true });
      return;
    }
    try {
      const body: DevLoginRequest = userId ? { userId } : {};
      const res = await fetch(`${API_URL}/auth/dev-login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        // 403 → dev-login disabled (production). Stay mounted; no token.
        setState({
          ready: true,
          authError:
            res.status === 403
              ? "Sign-in required (dev login disabled)."
              : `Could not start a session (${res.status}).`,
        });
        return;
      }
      const data = (await res.json()) as DevLoginResponse;
      setSession(data.token, data.userId);
    } catch (e) {
      // Network failure reaching our own API — the app still mounts; AI calls
      // will surface their own connection errors.
      setState({
        ready: true,
        authError:
          e instanceof Error ? e.message : "Could not reach the server.",
      });
    }
  })();
  return bootPromise;
}

/**
 * Allow a re-attempt after a clearSession()/401 (resets the once-guard so the
 * next ensureDevToken re-mints).
 */
export function resetBoot(): void {
  bootPromise = null;
}
