// netlify/functions/lib/retrieve.ts
import OpenAI from "openai";
import { createClient } from "@supabase/supabase-js";

export type Span = { title?: string | null; url?: string | null; content: string; score?: number };

const sb =
  process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY
    ? createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!)
    : null;

const EMBED_MODEL = process.env.OPENAI_EMBED_MODEL || "text-embedding-3-small";
const oai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY! });

function metaTitle(md: any): string | null {
  return md?.title || md?.file_title || md?.doc_title || md?.source_title || null;
}
function metaUrl(md: any): string | null {
  return md?.url || md?.source_url || md?.link || null;
}

// Light synonym expansion so embeddings & FTS “get” common phrasing
export function expandQuery(q: string): string {
  return q
    .replace(/\b1[:\-]1s?\b/gi, "one-on-one meetings")
    .replace(/\bone on ones?\b/gi, "one-on-one meetings")
    .replace(/\bone to ones?\b/gi, "one-on-one meetings");
}

// put this near the top of retrieve.ts
function asStringArray(x: unknown): string[] {
  if (Array.isArray(x)) return x.map(v => String(v));
  if (x == null) return [];
  return [String(x)];
}

export async function retrieveSpans(opts: {
  q: string;
  topK?: number;
  minScore?: number;   // similarity threshold for vector (0..1)
  ftsTopK?: number;    // how many FTS rows to take if vector misses
}): Promise<{ spans: Span[]; model: string; mode: "vector" | "fts" | "both" }> {
  const topK = opts.topK ?? 5;
  const minScore = opts.minScore ?? 0.55;
  const ftsTopK = opts.ftsTopK ?? 3;

  if (!sb) return { spans: [], model: EMBED_MODEL, mode: "vector" };

  const q = expandQuery(opts.q);

  // 1) Vector search via RPC if available
  let vecSpans: Span[] = [];
  try {
    const emb = await oai.embeddings.create({ model: EMBED_MODEL, input: q });
    const vec = emb.data[0]?.embedding as number[];

    // Assumes an RPC match_documents(query_embedding, match_count) returning (content, metadata, similarity)
    const { data: rows } = await sb.rpc("match_documents", {
      query_embedding: vec,
      match_count: topK,
    } as any);

    vecSpans = (rows || [])
      .map((r: any) => ({
        title: metaTitle(r.metadata ?? null),
        url: metaUrl(r.metadata ?? null),
        content: String(r.content || ""),
        score: typeof r.similarity === "number" ? r.similarity : undefined,
      }))
      // find the line like: arr.map((s) => s.trim())
const cleaned = asStringArray(vecSpans).map((s) => s.trim()).filter(Boolean);
  } catch {
    // ignore; fall through to FTS
  }

  if (vecSpans.length) return { spans: vecSpans, model: EMBED_MODEL, mode: "vector" };

  // 2) FTS fallback
  try {
    const { data: ftsRows } = await sb
      .from("documents")
      .select("content, metadata")
      .textSearch("content", q, { type: "websearch", config: "english" })
      .limit(ftsTopK);

    const ftsSpans =
      (ftsRows || []).map((r: any) => ({
        title: metaTitle(r.metadata),
        url: metaUrl(r.metadata),
        content: String(r.content || "").slice(0, 1500),
      })) || [];

    return { spans: ftsSpans, model: EMBED_MODEL, mode: "fts" };
  } catch {
    return { spans: [], model: EMBED_MODEL, mode: "vector" };
  }
}
