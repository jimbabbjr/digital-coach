// netlify/functions/lib/agents/router.ts
import { retrieveSpans } from "../retrieve";
import {
  getToolRegistry,
  detectToolFromAssistant,
  matchToolByIntent,
} from "../tools";

export type Msg = {
  role: "user" | "assistant" | "system";
  content: string;
};

type RagMeta = {
  count: number;
  mode: "raw" | null;
  model: string | null;
};

export type Decision = {
  route: "qa" | "coach" | "tools";
  ragSpans: Array<{ text: string; url?: string | null }>;
  ragMeta: RagMeta;
};

function isAffirmation(s: string): boolean {
  return /\b(yes|yep|y|sure|ok(ay)?|please|do it|that one|sounds good)\b/i.test(s);
}

function looksLikeToolAsk(s: string): boolean {
  return /\b(recommend|suggest|which|what)\b.*\b(tool|template|app|software|integration|feature)\b/i.test(
    s
  );
}

function looksLikeQuestion(s: string): boolean {
  return /\b(what|how|which|when|why|compare|difference|steps|guide|best|elements|meetings?|updates?|report|policy|process|template)\b/i.test(
    s
  );
}

export async function route(userText: string, messages: Msg[] = []): Promise<Decision> {
  const text = String(userText || "").trim();

  // 0) Follow-up “yes/please” after an assistant Try: line → go tools (only if it maps to registry)
  if (isAffirmation(text)) {
    const lastAssistant =
      [...messages].reverse().find((m) => m.role === "assistant")?.content || "";
    if (lastAssistant) {
      try {
        const docs = await getToolRegistry();
        const picked =
          detectToolFromAssistant(lastAssistant, docs) ||
          matchToolByIntent(text, docs);
        if (picked) {
          return {
            route: "tools",
            ragSpans: [],
            ragMeta: { count: 0, mode: null, model: null },
          };
        }
      } catch {
        /* ignore registry failures; fall through */
      }
    }
  }

  // 1) Explicit tool-seeking intent
  if (looksLikeToolAsk(text)) {
    return { route: "tools", ragSpans: [], ragMeta: { count: 0, mode: null, model: null } };
  }

  // 2) QA candidate? If yes, try retrieval (router owns RAG)
  if (looksLikeQuestion(text)) {
    try {
      const spans = await retrieveSpans(text, 3, 0.75);
      const count = Array.isArray(spans) ? spans.length : 0;

      if (count >= 1) {
        return {
          route: "qa",
          ragSpans: spans.map((s: any) => ({
            text: String(s?.text ?? ""),
            url: (s as any)?.url ?? null,
          })),
          ragMeta: {
            count,
            mode: "raw",
            model: process.env.OPENAI_EMBED_MODEL || "text-embedding-ada-002",
          },
        };
      }
    } catch {
      // retrieval outage → degrade gracefully to coach
    }
  }

  // 3) Default path: coaching (habits, planning, templates without specific facts)
  return { route: "coach", ragSpans: [], ragMeta: { count: 0, mode: null, model: null } };
}
