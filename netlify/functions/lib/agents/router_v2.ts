// netlify/functions/lib/agents/router_v2.ts
import OpenAI from "openai";
import type { ToolDoc } from "../tools";

export type Route = "qa" | "coach" | "tools";

export type RouteDecision = {
  route: Route;
  best_tool_slug?: string;
  tool_intent_score?: number; // 0..1
};

function isMediaAsk(t: string): boolean {
  const s = (t || "").toLowerCase();
  return /\b(book|books|author|read|reading list|recommend( me|ation)?s?|podcast|article|course)\b/.test(s);
}

export function isAffirmativeFollowUp(text: string): boolean {
  const t = String(text || "").trim().toLowerCase();
  return /^(yes|yep|sure|ok|okay|please|do it|go ahead|sounds good|let'?s do (it)?|make it so)\b/.test(t);
}

export function getCandidatesFromTools(tools: ToolDoc[], userText: string, max = 6) {
  const lower = String(userText || "").toLowerCase();
  const scored = tools.filter(t => (t as any)?.enabled && t?.title).map(t => {
    const patterns = (Array.isArray((t as any).patterns)
      ? (t as any).patterns
      : String((t as any).patterns || "").split(","))
      .map(s => s.trim()).filter(Boolean);

    let patternHits = 0;
    for (const rx of patterns) {
      try { if (new RegExp(rx, "i").test(userText)) patternHits++; } catch {}
    }

    const kws = (Array.isArray((t as any).keywords)
      ? (t as any).keywords
      : String((t as any).keywords || "").split(","))
      .map(s => s.trim().toLowerCase()).filter(Boolean);

    const kwHits = kws.reduce((n, k) => n + (lower.includes(k) ? 1 : 0), 0);
    return { slug: (t as any).slug, title: t.title, score: patternHits * 2 + kwHits };
  });

  return scored.sort((a,b) => (b.score ?? 0) - (a.score ?? 0)).slice(0, max);
}

// Safe wrapper: returns null if no key / model error.
export async function scoreRouteLLM(params: {
  apiKey?: string | null;
  model?: string | null;
  messages: { role: "user"|"assistant"|"system"; content: string }[];
  userText: string;
  candidates: { slug: string; title: string }[];
  lastRecoSlug?: string | null;
  
}): Promise<RouteDecision | null> {
  const { apiKey, model, messages, userText, candidates, lastRecoSlug } = params;
  if (!apiKey) return null;
if (isMediaAsk(userText)) {
  // Force a non-tools route so we don't hijack with Weekly Report, etc.
  return { route: "recs" as const };
}
  const client = new OpenAI({ apiKey: apiKey! });

  const sys = [
  "You are a strict router for an internal coaching app.",
  "Routes: 'qa' answers factual/Q&A, 'coach' gives guidance, 'tools' triggers an internal tool recommendation.",
  "NEVER choose 'tools' if the user is asking for books, podcasts, courses, or articles.",
  "Only pick a tool slug from candidates. If none fit, do not invent one.",
  "If user explicitly affirms a prior tool reco and lastRecoSlug exists, prefer route='tools' with that slug."
].join("\n");

  const payload = {
    userText, lastRecoSlug: lastRecoSlug || null,
    candidates: candidates.map(c => ({ slug: c.slug, title: c.title })),
    lastAssistant: messages.slice().reverse().find(m => m.role === "assistant")?.content || null
  };

  const res = await client.chat.completions.create({
    model: model || "gpt-4o-mini",
    temperature: 0,
    messages: [
      { role: "system", content: sys },
      { role: "user", content: JSON.stringify(payload) }
    ],
    response_format: { type: "json_object" }
  }).catch(() => null);

  const content = res?.choices?.[0]?.message?.content || "{}";
  try {
    const j = JSON.parse(content);
    const rd: RouteDecision = {
      route: (j.route as Route) || "coach",
      best_tool_slug: j.best_tool_slug || undefined,
      tool_intent_score: typeof j.tool_intent_score === "number" ? j.tool_intent_score : undefined
    };
    return rd;
  } catch {
    return null;
  }
}
