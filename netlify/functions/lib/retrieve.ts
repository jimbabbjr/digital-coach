// netlify/functions/lib/retrieve.ts
import { createClient } from "@supabase/supabase-js";
import OpenAI from "openai";

type Span = { title?: string | null; url?: string | null; content: string; score: number };
type Meta = { model: string | null; count: number };

const sb =
  process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY
    ? createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!)
    : null;

export async function retrieveSpans(opts: { q: string; topK?: number; minScore?: number }): Promise<{spans: Span[]; meta: Meta}> {
  const q = (opts.q || "").slice(0, 4000);
  if (!q || !sb) return { spans: [], meta: { model: null, count: 0 } };

  const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY! });
  const embedModel = process.env.OPENAI_EMBED_MODEL || "text-embedding-3-small";
  const { data: emb } = await openai.embeddings.create({ model: embedModel, input: q });
  const vec = emb[0]?.embedding;
  if (!vec) return { spans: [], meta: { model: embedModel, count: 0 } };

  const topK = opts.topK ?? 4;
  const { data, error } = await sb.rpc("match_docs", {
    query_embedding: vec as any,
    match_count: topK,
  });
  if (error || !Array.isArray(data)) return { spans: [], meta: { model: embedModel, count: 0 } };

  const spans = (data as any[]).map((r) => ({
    title: r.title ?? null,
    url: r.url ?? null,
    content: r.content,
    score: typeof r.similarity === "number" ? r.similarity : 0,
  }));

  const minScore = opts.minScore ?? 0.72;
  const filtered = spans.filter((s) => s.score >= minScore);
  return { spans: filtered, meta: { model: embedModel, count: filtered.length } };
}
