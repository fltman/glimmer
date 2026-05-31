import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import "./index.css";

const root = document.getElementById("root");
if (!root) throw new Error("#root not found");

// NOTE: StrictMode double-invokes effects in dev. CanvasHost guards against a
// duplicate mount() (engine.mount is idempotent for the same canvas), and the
// engine is a module singleton, so the GL context is created once.
createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
