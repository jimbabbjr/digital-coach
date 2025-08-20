// netlify/functions/lib/composer.ts
import OpenAI from "openai";
import type { Reply } from "./reply-schema";

const SYSTEM = `
You are a digital coach for small-business leaders. Decide the best response MODE and write it.
MODES:
- "media_recs": when the user asks for books/podcasts/articles/courses. Give 3–5 items with 1-line 'why' and a concrete takeaway. End with one short follow-up question.
- "offer_tool": when a tool would help. DO NOT print a detailed plan. Suggest the tool with a brief value pitch, propose minimal slots if helpful, and ALWAYS ask for confirmation first.
- "qa": when they asked for a factual answer.
- "coach": when they want guidance or a small playbook.

Rules:
- Never produce a tool plan without explicit user confirmation.
- Never choose "offer_tool" for media (books/podcasts/articles/courses).
- Keep language practical and nuts-and-bolts.
Return ONLY valid JSON matching the expected schema.
`;

export async function composeReply({
  userText,
  candidates,
  toolCatalog,
  model = process.env.OPENAI_CHAT_MODEL || "gpt-4o-mini",
}: {
  userText: string;
  candidates: Array<{ slug: string; title: string; score: number }>;
  toolCatalog: Record<string, { title: string; description: string; defaultSlots?: Record<string, any> }>;
  model?: string;
}): Promise<Reply> {
  const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY! });

  const context = {
    userText,
    candidates: candidates.map(c => ({
      slug: c.slug,
      title: toolCatalog[c.slug]?.title ?? c.title,
      score: c.score,
      description: toolCatalog[c.slug]?.description ?? "",
      defaults: toolCatalog[c.slug]?.defaultSlots ?? {},
    })),
  };

  const resp = await client.chat.completions.create({
    model,
    temperature: 0.3,
    response_format: { type: "json_object" },
    messages: [
      { role: "system", content: SYSTEM },
      { role: "user", content: JSON.stringify(context) },
    ],
  });

  const json = resp.choices?.[0]?.message?.content || "{}";
  return JSON.parse(json) as Reply;
}
