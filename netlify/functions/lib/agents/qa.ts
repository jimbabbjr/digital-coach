// netlify/functions/lib/agents/qa.ts
import OpenAI from "openai";
import type { Span } from "../retrieve";
import { retrieveSpans, expandQuery } from "../retrieve";

type HandleIn = {
  userText: string;
  messages?: Array<{ role: "user" | "assistant" | "system"; content: string }>;
  ragSpans?: Span[]; // from router; may be empty
};

type HandleOut = {
  route: "qa";
  text: string;
  meta?: { rag?: number; ragMode?: string | null; model?: string | null };
};

const CHAT_MODEL = process.env.OPENAI_CHAT_MODEL || "gpt-4o-mini";
const oai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY! });

const HOUSE_VOICE =
  (process.env.HOUSE_VOICE || "").trim() ||
  [
    "EntreLeadership/Ramsey voice:",
    "- Clear, direct, practical. Bottom-line first.",
    "- Root guidance in principles: ownership, stewardship, clarity, weekly cadence, visible follow-through.",
    "- No brand/tool recommendations unless provided by the app.",
    "- Output should be skimmable bullets with concrete steps.",
  ].join("\n");

function buildGroundingBlock(spans: Span[]): string {
  return spans
    .map((s, i) => {
      const title = (s.title || "").trim();
      const url = (s.url || "").trim();
      const body = (s.content || "").replace(/\s+/g, " ").slice(0, 900);
      return `#${i + 1} ${title || "Untitled"}${url ? ` (${url})` : ""}\n${body}`;
    })
    .join("\n\n");
}

export const QaAgent = {
  handle: async ({ userText, messages = [], ragSpans = [] }: HandleIn): Promise<HandleOut> => {
    // If router didn’t give spans, try ourselves (vector → FTS)
    let spans = ragSpans;
    if (!spans?.length) {
      const res = await retrieveSpans({ q: expandQuery(userText), topK: 5, minScore: 0.55, ftsTopK: 3 });
      spans = res.spans;
    }

    const grounded = spans.length > 0;

    const sys = [
      "You answer questions as an EntreLeadership/Ramsey coach.",
      HOUSE_VOICE,
      grounded
        ? "- Use ONLY the facts/ideas in GROUNDING when making claims. If something is not in GROUNDING, keep it general and principle-based."
        : "- Ground answers in the house principles. Avoid speculation and brands. Be concrete and actionable.",
    ].join("\n");

    const ctx = grounded
      ? ["GROUNDING (authoritative):", "────────────────", buildGroundingBlock(spans), "────────────────"].join("\n")
      : "";

    const prompt = [ctx, `QUESTION:\n${userText}`].filter(Boolean).join("\n\n");

    const chat = await oai.chat.completions.create({
      model: CHAT_MODEL,
      temperature: grounded ? 0.1 : 0.25,
      messages: [
        { role: "system", content: sys },
        ...messages.filter((m) => m.role === "assistant" || m.role === "user").slice(-3),
        { role: "user", content: prompt },
      ],
    });

    const content = chat.choices[0]?.message?.content?.trim() || "No answer.";
    return {
      route: "qa",
      text: content + (grounded ? `\n\nGrounded in: ${spans.map(s => s.title || "Untitled").join(", ")}` : ""),
      meta: { rag: spans.length, ragMode: grounded ? "qa-ground" : "qa-fallback", model: CHAT_MODEL },
    };
  },
};
