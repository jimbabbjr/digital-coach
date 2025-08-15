import type { Handler } from "@netlify/functions";
import OpenAI from "openai";
import { createClient } from "@supabase/supabase-js";

const supabase = createClient(
  process.env.SUPABASE_URL || "",
  process.env.SUPABASE_SERVICE_ROLE_KEY || "",
  { auth: { persistSession: false } }
);

export const handler: Handler = async (event) => {
  const url = new URL(event.rawUrl);
  const q = url.searchParams.get("q") || "weekly report";
  const t0 = parseFloat(url.searchParams.get("t0") || "0.80");
  const ks = parseInt(url.searchParams.get("k") || "5", 10);
  const model = url.searchParams.get("m")
    || process.env.OPENAI_EMBED_MODEL
    || "text-embedding-3-small";

  const env = {
    hasUrl: !!process.env.SUPABASE_URL,
    hasKey: !!process.env.SUPABASE_SERVICE_ROLE_KEY,
    hasOpenAI: !!process.env.OPENAI_API_KEY
  };

  const result: any = { q, k: ks, model, env, tries: [] };

  try {
    const countRes = await supabase.from("documents").select("id", { count: "exact", head: true });
    result.docsCount = countRes.count ?? null;
    result.docsCountError = countRes.error ? String(countRes.error.message) : null;

    if (!env.hasOpenAI) throw new Error("OPENAI_API_KEY missing");
    const oai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY! });
    const emb = await oai.embeddings.create({ model, input: q });
result.model = model;
    const v = emb.data[0].embedding as number[];
    result.embeddingDim = v.length;

    for (const t of [t0, 0.75, 0.70, 0.65, 0.60, 0.55, 0.0]) {
      const { data, error } = await supabase.rpc("match_documents", {
        query_embedding: v, match_threshold: t, match_count: ks
      });
      result.tries.push({
        threshold: t,
        error: error ? String(error.message || error) : null,
        count: Array.isArray(data) ? data.length : 0,
        sample: Array.isArray(data) ? data.slice(0, 2) : []
      });
      if (error) break;
    }
  } catch (e: any) {
    result.fatal = String(e?.message || e);
  }

  return {
    statusCode: 200,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(result, null, 2)
  };
};
