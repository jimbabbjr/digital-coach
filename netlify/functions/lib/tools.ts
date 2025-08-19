// netlify/functions/lib/tools.ts
import { createClient } from "@supabase/supabase-js";

export type ToolDoc = {
  slug: string;
  title: string;
  summary?: string | null;
  why?: string | null;
  outcome?: string | null;
  keywords?: string[] | string | null; // text[] or comma string or JSON array
  patterns?: string[] | string | null; // regex strings or comma string or JSON array
  enabled?: boolean | null;
};

const sb = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.VITE_SUPABASE_ANON_KEY!
);

// ---- tiny cache so we don't hit SB every call ----
let cache: { at: number; items: ToolDoc[] } | null = null;

function asList(v: string[] | string | null | undefined): string[] {
  if (!v) return [];
  if (Array.isArray(v)) return v.map(String);
  const s = String(v).trim();
  if (!s) return [];
  try {
    const j = JSON.parse(s);
    return Array.isArray(j) ? j.map(String) : s.split(",").map((x) => x.trim());
  } catch {
    return s.split(",").map((x) => x.trim()).filter(Boolean);
  }
}

function normTitle(s: string) {
  return s.toLowerCase().replace(/\btool\b/g, "").replace(/[^a-z0-9]+/g, " ").trim();
}

export async function getToolRegistry(): Promise<ToolDoc[]> {
  if (cache && Date.now() - cache.at < 60_000) return cache.items; // 60s
  const { data, error } = await sb
    .from("tool_docs")
    .select("slug,title,summary,why,outcome,keywords,patterns,enabled")
    .order("title", { ascending: true });

  if (error) throw error;
  const items = (data || []).filter((t) => t.enabled !== false);
  cache = { at: Date.now(), items };
  return items;
}

export function findByTitle(title: string, tools: ToolDoc[]): ToolDoc | null {
  const target = normTitle(title);
  let best: ToolDoc | null = null;
  let bestScore = 0;

  for (const t of tools) {
    const nt = normTitle(t.title);
    if (nt === target) return t;

    // light fuzzy via token overlap
    const ta = new Set(target.split(" ").filter(Boolean));
    const na = new Set(nt.split(" ").filter(Boolean));
    let overlap = 0;
    for (const w of ta) if (na.has(w)) overlap++;
    const score = overlap / Math.max(1, na.size);
    if (score > bestScore) {
      bestScore = score;
      best = t;
    }
  }

  return bestScore >= 0.6 ? best : null; // tighten if you want
}

export function extractTryTitle(assistantText: string): string | null {
  // grabs the title portion of: "Try: XYZ — why: ..."
  const m = /(^|\n)\s*Try:\s*([^\n—–-]+)/i.exec(assistantText || "");
  return m ? m[2].trim() : null;
}

export function stripAllTryLines(text: string): string {
  // removes any line that starts with "Try:"
  return (text || "")
    .split("\n")
    .filter((ln) => !/^\s*Try:/i.test(ln))
    .join("\n")
    .trim();
}

export function detectToolFromAssistant(
  assistantText: string,
  tools: ToolDoc[]
): ToolDoc | null {
  const title = extractTryTitle(assistantText);
  if (!title) return null;
  return findByTitle(title, tools);
}

export function matchToolByIntent(userText: string, tools: ToolDoc[]): ToolDoc | null {
  const text = (userText || "").toLowerCase();

  // pass 1: strong regex patterns per tool
  for (const t of tools) {
    for (const p of asList(t.patterns)) {
      try {
        const re = new RegExp(p, "i");
        if (re.test(text)) return t;
      } catch {
        // ignore malformed regex
      }
    }
  }

  // pass 2: keyword overlap
  let pick: ToolDoc | null = null;
  let best = 0;
  for (const t of tools) {
    const kws = asList(t.keywords).map((x) => x.toLowerCase());
    if (!kws.length) continue;
    let overlap = 0;
    for (const k of kws) {
    if (k.length >= 4 && text.includes(k)) overlap += 1;
  }
    if (overlap > best) {
      best = overlap;
      pick = t;
    }
  }
  if (pick && best >=2) return pick;
  return null;
  if (!pick) return null;
}

export function formatTryLine(t: ToolDoc) {
  const why = t.why || "helps you get this done reliably";
  const outcome = t.outcome || "faster progress with less manual effort";
  return `Try: ${t.title} — why: ${why}. Expected outcome: ${outcome}.`;
}
