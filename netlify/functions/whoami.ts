import type { Handler } from "@netlify/functions";
export const handler: Handler = async () => {
  const now = new Date().toISOString();
  return {
    statusCode: 200,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Expose-Headers": "X-Function-Name, X-When",
      "X-Function-Name": "whoami",
      "X-When": now,
    },
    body: JSON.stringify({ ok: true, now }),
  };
};
