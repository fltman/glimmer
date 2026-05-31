# @aips/web

React + TypeScript + Vite + Tailwind front-end for **ai-ps**, plus the
imperative WebGL2 editor engine.

## Run

```bash
pnpm --filter @aips/web dev      # vite dev server on :5173
pnpm --filter @aips/web build    # tsc + vite build
pnpm --filter @aips/web test     # vitest
```

Set `VITE_API_URL` (defaults to `http://localhost:8080`) to point at the API.

## Architecture

- `src/engine/` — framework-free editor engine. `EditorEngine` owns the canvas,
  the WebGL2 `Renderer`, the `Document`, and a dirty-flag rAF render loop. React
  never touches pixels.
  - `gl/Renderer.ts` — WebGL2 context + program/texture/FBO helpers, float-target
    feature detection with RGBA8 fallback.
  - `gl/shaders.ts` — quad vertex shader, Normal-blend fragment shader, present
    pass (linear→sRGB, checkerboard, ordered dither).
  - `math/mat3.ts` — 2D affine matrix helpers (view transform is separate from
    document space).
  - `export.ts` — full-resolution flatten → de-premultiply + sRGB → PNG.
- `src/model/Document.ts` — serializable layer model. CPU pixel sources are
  authoritative so the GPU is rebuildable after `webglcontextlost`.
- `src/state/useEngine.ts` — singleton engine + `useSyncExternalStore` snapshot.
- `src/ui/` — `CanvasHost` (mounts the canvas once), `Toolbar`, `LayersPanel`.
- `src/ai/` — `apiClient` (typed, uses `@aips/shared-types`), `AIPanel`
  (text-to-image → new layer).

## Compositing (Phase 1)

Layers composite bottom→top into a viewport-sized **linear** accumulator
(`RGBA16F`, RGBA8 fallback) with premultiplied source-over, then a present pass
encodes to sRGB over a checkerboard. Pan = drag, zoom = wheel (both attached to
the canvas directly, never via React). DPR-aware (drawing buffer =
`clientWidth * devicePixelRatio`, capped at 2x).
