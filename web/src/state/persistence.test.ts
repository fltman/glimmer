/**
 * Persistence tests for the swatch / brush-preset / pattern stores. Each case
 * seeds localStorage, then dynamically (re)imports the module so the singleton
 * stores run their load-on-init path against that storage.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

// jsdom's localStorage is incomplete here; install a minimal Map-backed store.
function installLocalStorage(): Map<string, string> {
  const map = new Map<string, string>();
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
  Object.defineProperty(window, "localStorage", {
    value: mock,
    configurable: true,
    writable: true,
  });
  return map;
}

beforeEach(() => {
  installLocalStorage();
  vi.resetModules();
});

describe("swatch persistence", () => {
  it("loads defaults when storage is empty", async () => {
    const { swatchStore } = await import("./tools");
    expect(swatchStore.get().length).toBeGreaterThan(0);
  });

  it("persists added swatches and reloads them", async () => {
    {
      const { swatchStore } = await import("./tools");
      const before = swatchStore.get().length;
      swatchStore.add({ r: 0.1, g: 0.2, b: 0.3, a: 1 });
      expect(swatchStore.get().length).toBe(before + 1);
    }
    vi.resetModules();
    const { swatchStore } = await import("./tools");
    const found = swatchStore
      .get()
      .some((c) => Math.abs(c.r - 0.1) < 0.01 && Math.abs(c.b - 0.3) < 0.01);
    expect(found).toBe(true);
  });

  it("falls back to defaults on corrupt JSON", async () => {
    window.localStorage.setItem("aips.swatches", "{not json");
    const { swatchStore } = await import("./tools");
    expect(swatchStore.get().length).toBeGreaterThan(0);
  });
});

describe("brush preset persistence", () => {
  it("does not duplicate built-ins on reload", async () => {
    let builtinCount = 0;
    let userId = "";
    {
      const { brushPresetStore } = await import("./tools");
      builtinCount = brushPresetStore.get().filter((p) => p.builtin).length;
      userId = brushPresetStore.add("My Brush");
      expect(userId).toBeTruthy();
    }
    vi.resetModules();
    const { brushPresetStore } = await import("./tools");
    const all = brushPresetStore.get();
    // Same number of built-ins (not duplicated) + the persisted user preset.
    expect(all.filter((p) => p.builtin).length).toBe(builtinCount);
    expect(all.filter((p) => !p.builtin).length).toBe(1);
    expect(all.some((p) => p.name === "My Brush")).toBe(true);
  });

  it("ignores a persisted built-in flag (never trusts it)", async () => {
    window.localStorage.setItem(
      "aips.brushPresets",
      JSON.stringify([{ id: "soft-round", name: "Evil", builtin: true, params: {} }]),
    );
    const { brushPresetStore } = await import("./tools");
    // The malformed built-in entry must be dropped, leaving only the real ones.
    expect(brushPresetStore.get().some((p) => p.name === "Evil")).toBe(false);
  });
});

describe("pattern state persistence", () => {
  it("persists selection and reloads it", async () => {
    {
      const { patternStore, BUILTIN_PATTERNS } = await import("./tools");
      const second = BUILTIN_PATTERNS[1]!.id;
      patternStore.setSelected(second);
      patternStore.setScale(2);
      expect(patternStore.getState().selectedId).toBe(second);
    }
    vi.resetModules();
    const { patternStore, BUILTIN_PATTERNS } = await import("./tools");
    expect(patternStore.getState().selectedId).toBe(BUILTIN_PATTERNS[1]!.id);
    expect(patternStore.getState().scale).toBe(2);
  });

  it("falls back to defaults for an unknown selectedId", async () => {
    window.localStorage.setItem(
      "aips.patternState",
      JSON.stringify({ selectedId: "does-not-exist", scale: 1, opacity: 1 }),
    );
    const { patternStore, BUILTIN_PATTERNS } = await import("./tools");
    expect(patternStore.getState().selectedId).toBe(BUILTIN_PATTERNS[0]!.id);
  });
});
