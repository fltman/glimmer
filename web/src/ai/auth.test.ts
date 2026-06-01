/**
 * Tests for the client auth/session store: token persistence, header
 * attachment, WS URL query-param injection, and the transparent dev-login boot
 * (success seeds a session; 403 records an authError without throwing).
 *
 * The module reads localStorage + import.meta.env at import time, so each case
 * installs a fresh storage + fetch mock and dynamically (re)imports the module.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

function installLocalStorage(seed?: Record<string, string>): Map<string, string> {
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

async function freshAuth(seed?: Record<string, string>) {
  installLocalStorage(seed);
  vi.resetModules();
  return import("./auth");
}

beforeEach(() => {
  installLocalStorage();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("auth header + ws url", () => {
  it("omits Authorization when no token is held", async () => {
    const auth = await freshAuth();
    const h = auth.authHeaders({ "Content-Type": "application/json" });
    expect(h["Content-Type"]).toBe("application/json");
    expect(h["Authorization"]).toBeUndefined();
  });

  it("attaches Bearer + ?token once a session is set", async () => {
    const auth = await freshAuth();
    auth.setSession("tok-123", "dev-user");
    expect(auth.getAuthToken()).toBe("tok-123");
    expect(auth.authHeaders()["Authorization"]).toBe("Bearer tok-123");
    const url = auth.wsUrlWithToken("/ws");
    expect(url).toMatch(/^ws/);
    expect(new URL(url).searchParams.get("token")).toBe("tok-123");
  });

  it("restores a stored token on import", async () => {
    const auth = await freshAuth({ "aips.auth.token": "stored-tok" });
    expect(auth.getAuthToken()).toBe("stored-tok");
    expect(auth.authHeaders()["Authorization"]).toBe("Bearer stored-tok");
  });

  it("clearSession drops the token and storage", async () => {
    const store = installLocalStorage({ "aips.auth.token": "x" });
    vi.resetModules();
    const auth = await import("./auth");
    auth.clearSession();
    expect(auth.getAuthToken()).toBeNull();
    expect(store.has("aips.auth.token")).toBe(false);
  });
});

describe("ensureDevToken (transparent boot)", () => {
  it("mints + persists a session via /auth/dev-login on a fresh boot", async () => {
    const store = installLocalStorage();
    vi.resetModules();
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        token: "dev-tok",
        userId: "dev-user",
        expiresAt: 0,
        balanceCredits: 1_000_000,
      }),
    })) as unknown as typeof fetch;
    vi.stubGlobal("fetch", fetchMock);

    const auth = await import("./auth");
    await auth.ensureDevToken();

    expect(auth.getAuthToken()).toBe("dev-tok");
    expect(auth.getAuthState().userId).toBe("dev-user");
    expect(auth.getAuthState().ready).toBe(true);
    expect(store.get("aips.auth.token")).toBe("dev-tok");
    // POSTed to dev-login exactly once.
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("records an authError (no throw) when dev-login is disabled (403)", async () => {
    installLocalStorage();
    vi.resetModules();
    const fetchMock = vi.fn(async () => ({
      ok: false,
      status: 403,
      json: async () => ({ error: "forbidden" }),
    })) as unknown as typeof fetch;
    vi.stubGlobal("fetch", fetchMock);

    const auth = await import("./auth");
    await expect(auth.ensureDevToken()).resolves.toBeUndefined();
    expect(auth.getAuthToken()).toBeNull();
    expect(auth.getAuthState().ready).toBe(true);
    expect(auth.getAuthState().authError).toMatch(/sign-in required/i);
  });

  it("trusts an already-stored token without calling dev-login", async () => {
    installLocalStorage({ "aips.auth.token": "restored" });
    vi.resetModules();
    const fetchMock = vi.fn() as unknown as typeof fetch;
    vi.stubGlobal("fetch", fetchMock);

    const auth = await import("./auth");
    await auth.ensureDevToken();
    expect(auth.getAuthToken()).toBe("restored");
    expect(auth.getAuthState().ready).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("is idempotent under concurrent calls (mints once)", async () => {
    installLocalStorage();
    vi.resetModules();
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        token: "once",
        userId: "dev-user",
        expiresAt: 0,
        balanceCredits: 1,
      }),
    })) as unknown as typeof fetch;
    vi.stubGlobal("fetch", fetchMock);

    const auth = await import("./auth");
    await Promise.all([auth.ensureDevToken(), auth.ensureDevToken()]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(auth.getAuthToken()).toBe("once");
  });
});
