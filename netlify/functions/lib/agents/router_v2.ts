// netlify/functions/lib/agents/router_v2.ts
import type { ToolDoc } from "../tools";

// ---------- helpers ----------
const norm = (x: any) => String(x ?? "").toLowerCase().trim();
const isMediaAsk = (t: string) =>
  /\b(book|books|author|reading\s*list|recommend( me|ation)?s?|podcast|article|course|courses?)\b/i.test(String(t || ""));

// ---------- candidate scorer (back-compat) ----------
export type ToolCandidate = { slug: string; title?: string; score: number };

/** Accepts (userText, tools) OR ({ userText, tools }) — tolerant to string[] or ToolDoc[]. */
export function getCandidatesFromTools(...args: any[]): ToolCandidate[] {
  const a = args[0], b = args[1];
  const userText: string = typeof a === "object" && a && "userText" in a ? a.userText : String(a ?? "");
  const toolsRaw: any = typeof a === "object" && a && "tools" in a ? a.tools : b;

  const text = norm(userText);
  const arr: any[] = Array.isArray(toolsRaw) ? toolsRaw : toolsRaw ? [toolsRaw] : [];

  const asTool = (t: any): ToolDoc => {
    if (t && typeof t === "object" && "slug" in t) return t as ToolDoc;
    const slug = String(t ?? "").trim();
    return { slug, title: slug, keywords: [slug] } as ToolDoc;
  };

  const STOP = new Set(["task","tasks","daily","day to day","day-to-day","everyday","update","updates","work","employee","employees"]);
  const NEG  = ["book","books","author","reading","recommendation","podcast","article","course","courses"];

  // Require ≥2 meaningful hits; ignore STOP words; penalize NEG
  const TOOL_FLOOR = 2;

  return arr
    .map(asTool)
    .map((t) => {
      const kw = t.keywords ?? [];
      const list = Array.isArray(kw) ? kw : [kw];
      let score = 0;
      for (const k of list) {
        const kk = norm(k);
        if (kk.length < 4) continue;
        if (STOP.has(kk)) continue;
        if (text.includes(kk)) score++;
      }
      for (const n of NEG) if (text.includes(n)) score--;
      return { slug: t.slug, title: t.title, score };
    })
    .filter(c => c.score >= TOOL_FLOOR)
    .sort((a, b) => b.score - a.score);
}

// ---------- LLM route scoring (back-compat overloads) ----------
export type LlmRouteResult = {
  route: "qa" | "coach" | "tools";
  reason: string;
  tool_intent_score: number;
  best_tool_slug: string | null;
  meta: { model: string };
};

export async function scoreRouteLLM(...args: any[]): Promise<LlmRouteResult> {
  let userText = "";
  if (typeof args[0] === "object" && args[0] && "userText" in args[0]) {
    userText = String(args[0].userText ?? "");
  } else if (typeof args[0] === "string" && typeof args[1] === "string") {
    userText = String(args[1] ?? "");  // (apiKey, userText, ctx)
  } else {
    userText = String(args[0] ?? "");
  }

  if (isMediaAsk(userText)) {
    return {
      route: "qa",
      reason: "media-ask-guard",
      tool_intent_score: 0,
      best_tool_slug: null,
      meta: { model: "router-local" },
    };
  }

  // Safe default; if you wire a real LLM router later, plug it here.
  return {
    route: "qa",
    reason: "default-qa",
    tool_intent_score: 0,
    best_tool_slug: null,
    meta: { model: "router-local" },
  };
}
