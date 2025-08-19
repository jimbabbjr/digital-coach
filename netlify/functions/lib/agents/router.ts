// netlify/functions/lib/agents/router.ts
import { retrieveSpans } from "../retrieve";
import { getCandidatesFromTools, scoreRouteLLM } from "./router_v2";

type Decision = {
  route: "qa" | "coach" | "tools";
  ragSpans: { content: string }[];
  ragMeta: { count: number; mode: string | null; model: string | null };
  best_tool_slug?: string | null;
};

export async function route(userText: string, messages: any[]): Promise<Decision> {
  const q = String(userText || "");
  const ql = q.toLowerCase();

  // 1) Cheap QA hint → try RAG immediately
  const qaHint =
    /\b(where|link|docs?|document(ed|ation)?|policy|wiki|confluence|notion)\b/.test(ql) ||
    /\b(find|show)\b.*\b(doc|policy|guid(e|eline)s?)\b/.test(ql);

  if (qaHint) {
    const { spans, meta } = await retrieveSpans({ q, topK: 4, minScore: 0.70 });
    if (spans.length) {
      return {
        route: "qa",
        ragSpans: spans,
        ragMeta: { count: spans.length, mode: "raw", model: meta.model || null },
      };
    }
  }

  // 2) LLM-assisted router (v2). If it returns, use it.
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
  return { route: "coach", ragSpans: [], ragMeta: { count: 0, mode: null, model: null } };
}
