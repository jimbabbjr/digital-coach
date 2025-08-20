// netlify/functions/lib/tools.ts
export type ToolDoc = {
  slug: string;
  title?: string;
  keywords?: string[];           // descriptive phrases
  negative_keywords?: string[];  // optional
};

export function asList<T = string>(v: any): T[] {
  if (!v) return [];
  return Array.isArray(v) ? v : [v];
}

const STOP = new Set(["task","tasks","daily","day-to-day","day to day","everyday","update","updates","work","employee","employees"]);
const norm = (x: any) => String(x ?? "").toLowerCase().trim();

/** Kept for any legacy callers that still use it. Requires ≥2 meaningful hits; no weekly fallback. */
export function matchToolByIntent(userText: string, tools: ToolDoc[]): ToolDoc | null {
  const text = norm(userText);
  let pick: ToolDoc | null = null;
  let best = -1;

  for (const t of tools || []) {
    const kws = asList<string>(t.keywords).map(norm).filter(Boolean);
    const negs = asList<string>(t.negative_keywords).map(norm).filter(Boolean);

    if (!kws.length) continue;

    let hits = 0;
    for (const k of kws) {
      if (k.length < 4) continue;
      if (STOP.has(k)) continue;
      if (text.includes(k)) hits++;
    }
    for (const n of negs) if (text.includes(n)) hits--;

    if (hits > best) { best = hits; pick = t; }
  }
  if (pick && best >= 2) return pick;
  return null;
}
