// netlify/functions/rag-smoke.ts
import type { Handler } from "@netlify/functions";
import { retrieveSpans } from "./lib/retrieve";

export const handler: Handler = async (event) => {
  try {
    const { q } = JSON.parse(event.body || "{}");
    const { spans, meta } = await retrieveSpans({ q: String(q || ""), topK: 4, minScore: 0 });
    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json; charset=utf-8" },
      body: JSON.stringify({ count: spans.length, model: meta.model, spans: spans.map(s => ({ score: s.score, snippet: s.content.slice(0, 160) })) }),
    };
  } catch (e: any) {
    return { statusCode: 500, body: JSON.stringify({ ok: false, error: String(e?.message || e) }) };
  }
};
