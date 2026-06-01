/**
 * Tests for the shared API error parser + global notice surface.
 *
 * errorFromResponse() must (a) build an ApiError carrying status/code/message
 * and the structured 402/429 extras, and (b) emit a matching global notice for
 * the 402/429/401 cases so the credit/rate-limit banner can render anywhere.
 * 401 must also clear the stored session.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

function installLocalStorage(seed?: Record<string, string>) {
  const map = new Map<string, string>(Object.entries(seed ?? {}));
  const mock: Storage = {
    get length() {
      return map.size;
    },
    clear: () => map.clear(),
    getItem: (k: string) => (map.has(k) ? map.get(k)! : null),
    setItem: (k: string, v: string) => void map.set(k, String(v)),
    removeItem: (k: string) => void map.delete(k),
    key: (i: number) => Array.from(map.keys())[i] ?? null,
  };
  Object.defineProperty(globalThis, "localStorage", {
    value: mock,
    configurable: true,
    writable: true,
  });
  return map;
}

/** Minimal Response stand-in supporting .clone().json()/.text() + headers. */
function fakeResponse(
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): Response {
  const json = async () => body;
  const text = async () => (typeof body === "string" ? body : JSON.stringify(body));
  const res: Partial<Response> = {
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers(headers),
    json,
    text,
    clone() {
      return this as Response;
    },
  };
  return res as Response;
}

beforeEach(() => {
  installLocalStorage();
  vi.resetModules();
});

describe("errorFromResponse", () => {
  it("emits insufficient_credits notice with required/balance on 402", async () => {
    const { errorFromResponse, subscribeApiNotice } = await import("./apiError");
    const seen: unknown[] = [];
    const off = subscribeApiNotice((n) => seen.push(n));

    const err = await errorFromResponse(
      fakeResponse(402, {
        error: "insufficient_credits",
        message: "Need more credits.",
        required: 14,
        balance: 3,
      }),
      "/ai/jobs",
    );
    off();

    expect(err.status).toBe(402);
    expect(err.code).toBe("insufficient_credits");
    expect(err.required).toBe(14);
    expect(err.balance).toBe(3);
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({
      kind: "insufficient_credits",
      required: 14,
      balance: 3,
    });
  });

  it("emits rate_limited notice and reads retryAfterSeconds on 429", async () => {
    const { errorFromResponse, subscribeApiNotice } = await import("./apiError");
    const seen: unknown[] = [];
    const off = subscribeApiNotice((n) => seen.push(n));

    const err = await errorFromResponse(
      fakeResponse(429, {
        error: "rate_limited",
        message: "Slow down.",
        retryAfterSeconds: 7,
      }),
      "/ai/jobs",
    );
    off();

    expect(err.code).toBe("rate_limited");
    expect(err.retryAfterSeconds).toBe(7);
    expect(seen[0]).toMatchObject({ kind: "rate_limited", retryAfterSeconds: 7 });
  });

  it("falls back to the Retry-After header when the body omits it", async () => {
    const { errorFromResponse } = await import("./apiError");
    const err = await errorFromResponse(
      fakeResponse(429, { error: "rate_limited", message: "x" }, { "Retry-After": "9" }),
      "/ai/jobs",
    );
    expect(err.retryAfterSeconds).toBe(9);
  });

  it("clears the stored session on 401 and emits unauthorized", async () => {
    const store = installLocalStorage({ "aips.auth.token": "stale" });
    vi.resetModules();
    const { errorFromResponse, subscribeApiNotice } = await import("./apiError");
    const seen: unknown[] = [];
    const off = subscribeApiNotice((n) => seen.push(n));

    const err = await errorFromResponse(
      fakeResponse(401, { error: "unauthorized", message: "no" }),
      "/account",
    );
    off();

    expect(err.status).toBe(401);
    expect(store.has("aips.auth.token")).toBe(false);
    expect(seen[0]).toMatchObject({ kind: "unauthorized" });
  });

  it("handles a non-JSON body without throwing", async () => {
    const { errorFromResponse } = await import("./apiError");
    const res = fakeResponse(500, "upstream boom");
    // Force JSON to throw so the text() fallback path runs.
    res.clone = () =>
      ({ json: async () => { throw new Error("not json"); } }) as unknown as Response;
    const err = await errorFromResponse(res, "/ai/jobs");
    expect(err.status).toBe(500);
    expect(err.message).toContain("boom");
  });
});
