import type { Handler } from "@netlify/functions";
export const handler: Handler = async () => {
  const base = process.env.URL || process.env.DEPLOY_PRIME_URL || "";
  if (base) {
    try { await fetch(`${base}/api/chat?mode=dry`); } catch {}
  }
  return { statusCode: 200, body: "ok" };
};
