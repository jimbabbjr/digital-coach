// netlify/functions/rag-smoke.ts
import type { Handler } from "@netlify/functions";
import { retrieveSpans } from "./lib/retrieve";
import { createClient } from "@supabase/supabase-js";

const sb =
  process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY
    ? createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!)
    : null;

export const handler: Handler = async (event) => {
  try {
    const { q } = JSON.parse(event.body || "{}");
    const query = String(q || "");

    // 1) Your retriever with minScore=0 (no filtering)
    const { spans, meta } = await retrieveSpans({ q: query, topK: 4, minScore: 0 });

    // 2) Raw RPC call (no filtering) so you can see the actual similarity numbers
    let raw: { similarity: number; snippet: string }[] = [];
    if (sb) {
      const { data } = await sb.rpc("match_docs", {
        query_embedding: null as any, // will be filled below
        match_count: 4,
      });
      // NOTE: we can't call the RPC without an embedding; this block is only
      // here to show shape. We rely on retrieveSpans() for the embedding call.
      // To see raw sims, look at spans[].score below.
    }

    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json; charset=utf-8" },
      body: JSON.stringify({
        ok: true,
        model: meta.model,
        count: spans.length,
        spans: spans.map(s => ({
          score: Number(s.score.toFixed(3)),
          snippet: s.content.slice(0, 160)
        })),
      }),
    };
  } catch (e: any) {
    return { statusCode: 500, body: JSON.stringify({ ok: false, error: String(e?.message || e) }) };
  }
};
