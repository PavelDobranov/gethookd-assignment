import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

// Self-hosted Geist (UI) and Geist Mono (keys/code), bundled so no external
// font request is made — matching the nginx privacy posture.
import "@fontsource/geist-sans/400.css";
import "@fontsource/geist-sans/500.css";
import "@fontsource/geist-sans/600.css";
import "@fontsource/geist-mono/400.css";
import "@fontsource/geist-mono/500.css";

import App from "./app";

const root = document.getElementById("root");

if (!root) {
  throw new Error("Root element not found");
}

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
