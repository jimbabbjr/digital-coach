// netlify/functions/warm.ts
import type { Handler } from "@netlify/functions";

export const handler: Handler = async () => {
  const base = process.env.URL || process.env.DEPLOY_PRIME_URL || "";
  if (base) {
    try {
      await fetch(`${base}/api/chat?mode=dry`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ q: "warm" }),
        keepalive: true,
      });
    } catch {}
  }
  return { statusCode: 200, body: "ok" };
};
