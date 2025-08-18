import React from "react";
import { createRoot } from "react-dom/client";
import App from "./App";

const el = document.getElementById("root")!;
createRoot(el).render(<App />);

// fire once on boot; keeps lambda and TLS hot
try {
  fetch("/api/chat?mode=dry", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ q: "prewarm" }),
    keepalive: true
  }).catch(() => {});
} catch {}
