// netlify/functions/lib/agents/router.ts
import { retrieveSpans } from "../retrieve";
import {
  getToolRegistry,
  detectToolFromAssistant,
  matchToolByIntent,
} from "../tools";

export type Msg = { role: "user" | "assistant" | "system"; content: string };
export type Decision = {
  route: "qa" | "coach" | "tools";
  ragSpans: Array<{ text: string; url?: string }>;
  ragMeta: { count: number; mode: "raw" | null; model: string | null };
};

function isAffirmation(s: string) {
  return /\b(yes|yep|y|sure|ok(ay)?|please|do it|that one|sounds good)\b/i.test(s);
}

function looksLikeToolAsk(s: string) {
  return /\b(recommend|suggest|which|what)\b.*\b(tool|template|app|software|integration|feature)\b/i.test(
    s
  );
}

function looksLikeQuestion(s: string) {
  return /\b(what|how|which|when|why|compare|difference|steps|guide|best|elements|meetings?|updates?|report|policy|process|template)\b/i.test(
    s
  );
}

export async function route(
  userText: string,
  messages: Msg[] = []
): Promise<Decision> {
  const text = String(userText || "").trim();

  // 0) Follow-up “yes/please” after an assistant Try: line → go tools (only if it maps to registry)
  if (isAffirmation(text)) {
    const lastAssistant =
      [...messages].reverse().find((m) => m.role === "assistant")?.content || "";
    if (lastAssistant) {
      const docs = await getToolRegistry();
      const picked = detectToolFromAssistant(lastAssistant, docs) || matchToolByIntent(text, docs);
      if (picked) {
        return {
          route: "tools",
          ragSpans: [],
          ragMeta: { count: 0, mode: null, model: null },
        };
      }
    }
  }

  // 1) Explicit tool-seeking intent
  if (looksLikeToolAsk(text)) {
    return {
      route: "tools",
      ragSpans: [],
      ragMeta: { count: 0, mode: null, model: null },
    };
  }

  // 2) QA candidate? If yes, try retrieval (router owns RAG)
  if (looksLikeQuestion(text)) {
    try {
      // Threshold tuned from your earlier rag-test; k=3 is plenty for short answers.
      const spans = await retrieveSpans(text, 3, 0.75);
      const count = spans.length;
      if (count >= 2 || (count === 1 /* allow single, still helpful */)) {
        return {
          route: "qa",
          ragSpans: spans.map((s) => ({ text: s.text, url: s.url })),
          ragMeta: {
            count,
            mode: "raw",
            model: process.env.OPENAI_EMBED_MODEL || "text-embedding-ada-002",
          },
        };
      }
      // No useful hits → coaching is likely better than hallucinated QA
      return {
        route: "coach",
        ragSpans: [],
        ragMeta: { count: 0, mode: null, model: null },
      };
    } catch {
      // Retrieval outage → degrade gracefully to coach
      return {
        route: "coach",
        ragSpans: [],
        ragMeta: { count: 0, mode: null, model: null },
      };
    }
  }

  // 3) Default path: coaching (habits, planning, templates without specific facts)
  return {
    route: "coach",
    ragSpans: [],
    ragMeta: { count: 0, mode: null, model: null },
  };
}
