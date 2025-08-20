// netlify/functions/lib/agents/router.ts
import { scoreRouteLLM } from "./router_v2";

const isMediaAsk = (t: string) =>
  /\b(book|books|author|reading\s*list|recommend( me|ation)?s?|podcast|article|course|courses?)\b/i.test(String(t || ""));
const isAffirmative = (s: string) =>
  /\b(yes|yep|sounds good|do it|let'?s try|ok(ay)?|go ahead)\b/i.test(String(s || ""));

export type RouteUnion = "qa" | "coach" | "tools";
export type RouteResult = {
  impl: string;
  route: RouteUnion;
  ragSpans: any[];
  ragMeta: { count: number; mode: string | null; model: string | null };
  best_tool_slug: string | null;
};

// Overloaded entry: (userText, messages?) OR ({ userText, messages, lastRecoSlug })
export async function route(a: any, b?: any): Promise<RouteResult> {
  const userText: string = typeof a === "string" ? a : a.userText;
  const messages: any[] = typeof a === "string" ? (b || []) : (a.messages || []);
  const lastRecoSlug: string | null = typeof a === "string" ? null : (a.lastRecoSlug ?? null);

  if (isMediaAsk(userText)) {
    return { impl: "qa-first-v2", route: "qa", ragSpans: [], ragMeta: { count: 0, mode: null, model: null }, best_tool_slug: null };
  }

  const lastUserMsg = [...(messages || [])].reverse().find(m => m.role === "user")?.content ?? "";
  const sticky = isAffirmative(lastUserMsg) ? lastRecoSlug : null;

  const scored = await scoreRouteLLM(userText, { messages, lastRecoSlug: sticky });
  const picked: RouteUnion = (scored?.route as RouteUnion) || "qa";

  return {
    impl: "qa-first-v2",
    route: picked,
    ragSpans: [],
    ragMeta: { count: 0, mode: null, model: null },
    best_tool_slug: sticky,
  };
}
