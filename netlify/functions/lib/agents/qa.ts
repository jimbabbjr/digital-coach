// netlify/functions/lib/agents/qa.ts
import OpenAI from "openai";

const SYSTEM = `You are a sharp, practical coach for small-biz leaders.
Keep answers punchy and skimmable. Prefer bullets. ≤180 words.
Ask at most one short clarifying question only if needed.
If given private context, use it silently (no citations, no URLs).
If you mention tools, do not include links.`;

// Belt-and-suspenders: remove URLs from private context
function scrubContext(s: string) {
  return String(s || "").replace(/\bhttps?:\/\/\S+/gi, "");
}

export const QaAgent = {
  route: "qa" as const,

  async handle({
    userText,
    messages = [],
    ragSpans = [],
  }: {
    userText: string;
    messages?: Array<{ role: "user" | "assistant" | "system"; content: string }>;
    ragSpans?: Array<{ text: string; url?: string }>;
  }) {
    const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

    const contextMsg =
      ragSpans.length > 0
        ? {
            role: "system" as const,
            content:
              "Private notes for grounding only (do not reference or cite):\n" +
              ragSpans.map((s) => `• ${scrubContext(s.text)}`).join("\n"),
          }
        : null;

    const chat = [
      { role: "system" as const, content: SYSTEM },
      ...(contextMsg ? [contextMsg] : []),
      ...messages,
      { role: "user" as const, content: userText },
    ];

    const res = await client.responses.create({
      model: process.env.OPENAI_CHAT_MODEL || "gpt-4o-mini",
      input: chat,
    });

    const text =
      (res as any)?.output_text ||
      (res as any)?.output?.[0]?.content?.[0]?.text ||
      "";

    return {
      route: "qa" as const,
      text: String(text || "").trim(),
      reco: false, // chat.ts will clamp/append approved internal Try: lines
      meta: {
        rag: ragSpans.length,
        ragMode: ragSpans.length ? "raw" : null,
        model: process.env.OPENAI_CHAT_MODEL || "gpt-4o-mini",
        recoSlug: null,
      },
    };
  },
};
