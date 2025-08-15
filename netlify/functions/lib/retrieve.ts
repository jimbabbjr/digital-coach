import OpenAI from "openai";
import { createClient } from "@supabase/supabase-js";

export type Span = { text: string; url?: string; score: number; meta?: any };

const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { auth: { persistSession: false } }
);

// use the same model your index used
const EMBED_MODEL = process.env.OPENAI_EMBED_MODEL || "text-embedding-3-small";
const oai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY! });

// --- tiny cache to cut repeat latency
const embedCache = new Map<string, { v: number[]; ts: number }>();
const EMBED_TTL_MS = 5 * 60 * 1000;

async function embed(q: string): Promise<number[]> {
  const key = `${EMBED_MODEL}:${q.trim().toLowerCase()}`;
  const hit = embedCache.get(key);
  if (hit && Date.now() - hit.ts < EMBED_TTL_MS) return hit.v;

  const e = await oai.embeddings.create({ model: EMBED_MODEL, input: q });
  const v = e.data[0].embedding as number[];
  embedCache.set(key, { v, ts: Date.now() });
  return v;
}

export async function retrieveSpans(
  query: string,
  k = 3,
  threshold = 0.75,   // good for ada-002 on your corpus
  minScore = 0.35,
  minLen = 160
): Promise<Span[]> {
  const v = await embed(query);

  for (const t of [threshold, 0.72, 0.70, 0.65, 0.60, 0.0]) {
    const { data, error } = await supabase.rpc("match_documents", {
      query_embedding: v,
      match_threshold: t,
      match_count: Math.max(5, k),
    });

    if (error) { console.error("match_documents error", error); return []; }

    const spans = ((data ?? []) as any[])
      .map((r: any) => ({
        text: r.content as string,
        url: r.metadata?.url ?? r.metadata?.source ?? undefined,
        score: r.similarity as number,
        meta: r.metadata,
      }))
      .filter(s => (s.score ?? 0) >= minScore && (s.text?.length ?? 0) >= minLen)
      .filter((s, i, arr) => i === arr.findIndex(t => t.text.slice(0,120) === s.text.slice(0,120))) // de-dupe
      .slice(0, k);

    if (spans.length) return spans;
  }
  return [];
}
