/// <reference types="vitest" />
import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

// Vite config for the @aips/web app. The dev server runs on 5180 (matches
// WEB_ORIGIN in .env). VITE_API_URL is read via import.meta.env.
//
// envDir points at the monorepo root so the single root .env is the source of
// truth. Vite only exposes VITE_-prefixed vars to the client bundle, so the
// provider secrets in that file are never shipped to the browser.
export default defineConfig({
  plugins: [react()],
  envDir: "..",
  // Pre-bundle the (large) transformers.js dep at dev-server start so the RMBG
  // Web Worker's first import doesn't trigger Vite's on-the-fly dep discovery,
  // which would force a full-page reload mid-session (losing canvas state).
  optimizeDeps: { include: ["@huggingface/transformers"] },
  worker: { format: "es" },
  server: {
    port: 5180,
    strictPort: true,
  },
  build: {
    target: "es2022",
    sourcemap: true,
  },
  test: {
    environment: "jsdom",
    globals: true,
  },
});
