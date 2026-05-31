/**
 * Client capability probe — decides client-vs-server execution for ops that can
 * run locally (currently background removal via RMBG-1.4 in transformers.js).
 *
 * The probe is one-time and memoized: detecting WebGPU requires an async
 * adapter request, but `isClientRmbgCapable()` resolves the cached boolean
 * after the first call. We treat "has WebGPU OR has WebAssembly" as capable —
 * transformers.js falls back to a wasm backend when WebGPU is unavailable, so
 * any modern browser qualifies; WebGPU just makes it dramatically faster.
 */
import type { ClientCapabilities } from "@aips/shared-types";

let cached: ClientCapabilities | null = null;
let inflight: Promise<ClientCapabilities> | null = null;

/** True if the WebAssembly engine is present (effectively always, modern web). */
function hasWasm(): boolean {
  return typeof WebAssembly === "object" && typeof WebAssembly.instantiate === "function";
}

/** SharedArrayBuffer presence is a proxy for cross-origin-isolated wasm threads. */
function hasWasmThreads(): boolean {
  return (
    typeof SharedArrayBuffer !== "undefined" &&
    (globalThis.crossOriginIsolated ?? false)
  );
}

/** WebAssembly SIMD is supported by every browser that ships transformers.js v3. */
function hasWasmSimd(): boolean {
  // A tiny module with a v128 const — instantiation throws if SIMD is absent.
  if (!hasWasm()) return false;
  try {
    const simdTest = new Uint8Array([
      0, 97, 115, 109, 1, 0, 0, 0, 1, 5, 1, 96, 0, 1, 123, 3, 2, 1, 0, 10,
      10, 1, 8, 0, 65, 0, 253, 15, 253, 98, 11,
    ]);
    return WebAssembly.validate(simdTest);
  } catch {
    return false;
  }
}

async function probeWebGpu(): Promise<boolean> {
  const gpu = (navigator as Navigator & { gpu?: unknown }).gpu;
  if (!gpu) return false;
  try {
    const adapter = await (
      gpu as { requestAdapter(): Promise<unknown | null> }
    ).requestAdapter();
    return !!adapter;
  } catch {
    return false;
  }
}

/** Run the probe once; subsequent calls return the memoized profile. */
export async function probeClientCapabilities(): Promise<ClientCapabilities> {
  if (cached) return cached;
  if (inflight) return inflight;
  inflight = (async () => {
    const webgpu = await probeWebGpu();
    const profile: ClientCapabilities = {
      webgpu,
      wasmSimd: hasWasmSimd(),
      wasmThreads: hasWasmThreads(),
      deviceMemoryGb: (navigator as Navigator & { deviceMemory?: number })
        .deviceMemory,
      // Flipped to true by rmbgClient once the model warms up successfully.
      rmbgReady: false,
    };
    cached = profile;
    return profile;
  })();
  return inflight;
}

/**
 * Whether the browser can run RMBG-1.4 locally. WebGPU is preferred; wasm is an
 * acceptable (slower) fallback, so capability is "has WebGPU or has wasm".
 */
export async function isClientRmbgCapable(): Promise<boolean> {
  const p = await probeClientCapabilities();
  return p.webgpu || p.wasmSimd || hasWasm();
}

/** Synchronous best-effort guess for first paint (before the async probe). */
export function isClientRmbgCapableSync(): boolean {
  const gpu = (navigator as Navigator & { gpu?: unknown }).gpu;
  return !!gpu || hasWasm();
}

/** Mark the RMBG model as warmed up (called after a successful client run). */
export function markRmbgReady(): void {
  if (cached) cached.rmbgReady = true;
}

/** The current cached profile, or null before the first probe. */
export function getClientCapabilities(): ClientCapabilities | null {
  return cached;
}
