// netlify/functions/lib/tool-select.ts
import OpenAI from "openai";

export type RankableTool = { slug: string; title: string; description: string };

function jaccard(a: Set<string>, b: Set<string>) {
  const inter = new Set([...a].filter(x => b.has(x))).size;
  const uni = new Set([...a, ...b]).size || 1;
  return inter / uni;
}
function tokenize(s: string) {
  return new Set(String(s || "").toLowerCase().match(/[a-z0-9]+/g) || []);
}

async function embedText(client: OpenAI, text: string): Promise<number[]> {
  const model = process.env.OPENAI_EMBED_MODEL || "text-embedding-3-small";
  const out = await client.embeddings.create({ model, input: text });
  return out.data[0].embedding as number[];
}
function cos(a: number[], b: number[]) {
  let dot = 0, na = 0, nb = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) { dot += a[i]*b[i]; na += a[i]*a[i]; nb += b[i]*b[i]; }
  return dot / (Math.sqrt(na) * Math.sqrt(nb) || 1);
}

/** Rank tools by semantic similarity (embeddings). Falls back to token Jaccard if no API key. */
export async function rankTools(userText: string, tools: RankableTool[]) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    const q = tokenize(userText);
    return tools
      .map(t => ({ slug: t.slug, title: t.title, score: jaccard(q, tokenize(t.title + " " + t.description)) }))
      .sort((a,b) => b.score - a.score)
      .slice(0, 5);
  }
  const client = new OpenAI({ apiKey });
  const qv = await embedText(client, userText);
  const scored = [];
  for (const t of tools) {
    const tv = await embedText(client, `${t.title} — ${t.description}`);
    scored.push({ slug: t.slug, title: t.title, score: cos(qv, tv) });
  }
  return scored.sort((a,b) => b.score - a.score).slice(0, 5);
}
