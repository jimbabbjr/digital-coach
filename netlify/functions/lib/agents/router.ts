// netlify/functions/lib/agents/router.ts
import { retrieveSpans } from "../retrieve";
import { getCandidatesFromTools, scoreRouteLLM } from "./router_v2";

export type Decision = {
  route: "qa" | "coach" | "tools";
  ragSpans: { content: string }[];
  ragMeta: { count: number; mode: string | null; model: string | null };
  best_tool_slug?: string | null;
  // debug marker so chat_v2 can expose which router impl ran
  impl?: string;
};

// QA-first router: try retrieval when question looks doc/policy-ish.
// If nothing retrieved, fall back to LLM router. Else default=coach.
export async function route(userText: string, messages: any[]): Promise<Decision> {
  const q = String(userText || "");
  const ql = q.toLowerCase();

  // 1) Cheap QA hint → try RAG immediately with a lenient floor for small corpora
  const qaHint =
    /\b(where|link|docs?|document(ed|ation)?|policy|wiki|confluence|notion)\b/.test(ql) ||
    /\b(find|show)\b.*\b(doc|policy|guid(e|eline)s?)\b/.test(ql);

  if (qaHint) {
    const { spans, meta } = await retrieveSpans({ q, topK: 4, minScore: 0.55 });
    if (spans.length) {
      return {
        impl: "qa-first-v2",
        route: "qa",
        ragSpans: spans,
        ragMeta: { count: spans.length, mode: "raw", model: meta.model || null },
      };
    }
  }

  // 2) LLM-assisted router (best-effort). Safe to fail.
  try {
    const candidates = getCandidatesFromTools ? getCandidatesFromTools([], q, 6) : [];
    const scored = await scoreRouteLLM({
      apiKey: process.env.OPENAI_API_KEY,
      model: process.env.OPENAI_CHAT_MODEL || "gpt-4o-mini",
      messages,
      userText: q,
      candidates,
      lastRecoSlug: null,
    });
    if (scored) {
      return {
        impl: "qa-first-v2",
        route: scored.route as Decision["route"],
        ragSpans: [],
        ragMeta: { count: 0, mode: null, model: null },
        best_tool_slug: scored.best_tool_slug || null,
      };
    }
  } catch {
    // ignore and fall through
  }

  // 3) Default: coach
  return { impl: "qa-first-v2", route: "coach", ragSpans: [], ragMeta: { count: 0, mode: null, model: null } };
}
