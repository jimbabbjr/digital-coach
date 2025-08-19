import type { Handler } from "@netlify/functions";
import { route as pickRoute } from "./lib/agents/router";

export const handler: Handler = async (event) => {
  try {
    const { q = "" } = JSON.parse(event.body || "{}");
    const decision = await pickRoute(String(q), []);
    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json; charset=utf-8" },
      body: JSON.stringify({
        route: decision?.route || null,
        ragCount: decision?.ragMeta?.count ?? 0,
        impl: (decision as any)?.impl || null,
      }),
    };
  } catch (e: any) {
    return { statusCode: 500, body: JSON.stringify({ ok: false, error: String(e?.message || e) }) };
  }
};
