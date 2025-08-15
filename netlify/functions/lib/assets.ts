import { createClient } from "@supabase/supabase-js";

export type AssetPick = {
  kind: "tool" | "playbook";
  key: string;
  title: string;
  why: string;
  outcome: string;
  keywords?: string[];
};

const sb = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { auth: { persistSession: false } }
);

let CATALOG: AssetPick[] = [];
let LOADED = false;

export async function ensureCatalog() {
  if (LOADED && CATALOG.length) return CATALOG;
  const { data, error } = await sb
    .from("tools_catalog")
    .select("key,title,kind,why,outcome,keywords")
    .eq("enabled", true);
  if (error) { console.error("load tools_catalog error", error); CATALOG = []; LOADED = true; return CATALOG; }
  CATALOG = (data || []) as AssetPick[];
  LOADED = true;
  return CATALOG;
}

// normalize titles: strip markdown and punctuation, lowercase
function normTitle(s: string) {
  return s
    // strip markdown **bold**, *italic*, `code`, quotes/tilde
    .replace(/[*_`"'~]/g, "")
    // strip markdown link [Label](url) -> Label
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .trim()
    .toLowerCase();
}

// Keep at most one internal Try: line; drop externals.
export async function sanitizeTryLines(text: string) {
  const catalog = await ensureCatalog();
  const allowed = new Set(catalog.map(a => normTitle(a.title)));

  const lines = text.split(/\r?\n/);
  const out: string[] = [];
  let keptOne = false;

  for (const line of lines) {
    // match: "Try: <title> — why" with various dash characters or colon
    const m = line.match(/^\s*Try:\s*(.*?)\s*(?:—|–|—|-|:)\s*why\b/i);
    if (!m) { out.push(line); continue; }

    const titleRaw = m[1];
    const t = normTitle(titleRaw);
    if (!allowed.has(t)) {
      // external recommendation → drop the line entirely
      continue;
    }
    if (!keptOne) { out.push(line); keptOne = true; }
    // if we already kept one internal Try line, drop duplicates
  }

  return { text: out.join("\n"), hasAllowedTry: keptOne };
}

// Simple query-aware ranking for your own pick
function score(item: AssetPick, intent: "decide" | "learn", q: string) {
  let s = 0;
  if (intent === "decide" && item.kind === "playbook") s += 1;
  if (intent === "learn" && item.kind === "tool") s += 1;
  if (item.keywords?.length) {
    const Q = q.toLowerCase();
    for (const k of item.keywords) if (Q.includes(k.toLowerCase())) s += 1;
  }
  return s;
}

export async function selectAssets(intent: "decide"|"learn", q: string, topN = 1): Promise<AssetPick[]> {
  const catalog = await ensureCatalog();
  if (!catalog.length) return [];
  return [...catalog].sort((a,b)=>score(b,intent,q)-score(a,intent,q)).slice(0, topN);
}
