import React from "react";
import { createRoot } from "react-dom/client";
import App from "./App";

const el = document.getElementById("root")!;
createRoot(el).render(<App />);

fetch("/api/ping").catch(() => {});
// keep it warm every 4 min while tab open
setInterval(() => fetch("/api/ping").catch(()=>{}), 4 * 60 * 1000);
