// lib/agents/router_v2.ts
import OpenAI from "openai";
import type { SupabaseClient } from "@supabase/supabase-js";

type Route = "qa" | "coach" | "tools";

export type Candidate = {
  slug: string;
  title: string;
  summary?: string;
  why?: string;
  keywords?: string[];
  enabled?: boolean;
  score?: number;
};

export type RouteDecision = {
  route: Route;
  tool_intent_score: number;          // 0..1
  best_tool_slug?: string;            // must be from candidates
  needs_confirmation?: boolean;
  reason?: string;
};

export async function getToolCandidates(
  sb: SupabaseClient,
  userText: string,
  max = 6
): Promise<Candidate[]> {
  // Pull all enabled tools once; cheap and simple. You can cache in memory if warm runtime.
  const { data, error } = await sb
    .from("tool_docs")
    .select("slug,title,summary,why,keywords,patterns,enabled")
    .eq("enabled", true);

  if (error || !data) return [];

  // Pass 1: regex pattern hits
  const lower = userText.toLowerCase();
  const scored: Candidate[] = data.map((t: any) => {
    let patternHits = 0;
    try {
      const patterns = (t.patterns || "").split(",").map((s: string) => s.trim()).filter(Boolean);
      patternHits = patterns.reduce((acc: number, rx: string) => {
        try { return acc + (new RegExp(rx, "i").test(userText) ? 1 : 0); }
        catch { return acc; }
      }, 0);
    } catch { /* noop */ }

    // Pass 2: keyword overlap
    const kws: string[] = (t.keywords || "").split(",").map((s: string) => s.trim().toLowerCase()).filter(Boolean);
    const kwHits = kws.reduce((acc, k) => acc + (lower.includes(k) ? 1 : 0), 0);

    const score = patternHits * 2 + kwHits; // simple heuristic
    return { slug: t.slug, title: t.title, summary: t.summary, why: t.why, keywords: kws, enabled: !!t.enabled, score };
  });

  return scored
    .filter(c => c.enabled)
    .sort((a, b) => (b.score ?? 0) - (a.score ?? 0))
    .slice(0, max);
}

export function isAffirmativeFollowUp(text: string): boolean {
  const t = text.trim().toLowerCase();
  return /^(yes|yep|sure|do it|let's do it|go ahead|sounds good|ok|okay|please|yessir|make it so)\b/.test(t);
}

export async function scoreRouteLLM(opts: {
  client: OpenAI;
  model?: string;
  messages: { role: "user"|"assistant"|"system"; content: string }[];
  userText: string;
  candidates: Candidate[];
  lastRecoSlug?: string | null;
}) : Promise<RouteDecision> {
  const { client, model = process.env.OPENAI_CHAT_MODEL || "gpt-4o-mini", messages, userText, candidates, lastRecoSlug } = opts;

  // Keep payload tiny: only send compact candidate list.
  const cList = candidates.map(c => ({
    slug: c.slug, title: c.title,
    why: c.why, summary: c.summary,
    keywords: (c.keywords || []).slice(0, 6)
  }));

  const sys = [
    "You are a strict router for an internal coaching app.",
    "Routes: 'qa' answers factual/Q&A using provided spans, 'coach' gives guidance/templates, 'tools' triggers an internal tool recommendation.",
    "Only choose a tool slug that appears in candidates. If none fits, do NOT invent one.",
    "If the user explicitly affirms a prior recommendation (e.g., 'yes please') and lastRecoSlug is present, prefer route='tools' with that slug.",
    "Return concise JSON only."
  ].join(" ");

  const schema = {
    type: "object",
    properties: {
      route: { enum: ["qa","coach","tools"] },
      tool_intent_score: { type: "number" },
      best_tool_slug: { type: ["string","null"] },
      needs_confirmation: { type: "boolean" },
      reason: { type: "string" }
    },
    required: ["route","tool_intent_score","needs_confirmation"],
    additionalProperties: false
  };

  // NOTE: Use the Responses API / JSON mode if you prefer. Keeping this generic.
  const completion = await client.chat.completions.create({
    model,
    temperature: 0,
    messages: [
      { role: "system", content: sys },
      { role: "user", content: JSON.stringify({
          userText,
          lastRecoSlug: lastRecoSlug || null,
          candidates: cList,
          lastAssistant: messages.slice().reverse().find(m => m.role === "assistant")?.content || null
      }) }
    ],
    response_format: { type: "json_object" }
  });

  const raw = completion.choices[0]?.message?.content || "{}";
  let parsed: any = {};
  try { parsed = JSON.parse(raw); } catch { /* fallback below */ }

  const rd: RouteDecision = {
    route: parsed.route ?? "coach",
    tool_intent_score: Number(parsed.tool_intent_score ?? 0),
    best_tool_slug: parsed.best_tool_slug ?? undefined,
    needs_confirmation: Boolean(parsed.needs_confirmation ?? false),
    reason: parsed.reason
  };
  return rd;
}
