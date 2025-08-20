// netlify/functions/lib/composer.ts
import OpenAI from "openai";
import type { Reply } from "./reply-schema";

const SYSTEM = `
You are a practical digital coach for small-business leaders. You must:
- Read conversation history to understand context and references.
- If the last assistant message listed recommendations (books/podcasts/etc.) and the user references one (title or author or partial title), return MODE "deep_dive" with a concise, actionable summary geared to entry-level employees.
- If the user replies with "no" (e.g., "no i haven't", "not yet") after a suggestion, respond with a short rollout plan they can start today.

MODES:
- "media_recs": when the user asks for books/podcasts/articles/courses. Give 3–5 items with 1-line 'why' and a concrete takeaway. End with a single short follow-up question (key 'ask').
- "offer_tool": when a tool would help. DO NOT print a detailed plan. Suggest the tool with a brief value pitch, propose minimal slots if helpful, and ALWAYS ask for confirmation first.
- "deep_dive": when the user selects an item from prior recommendations. Provide a focused, nuts-and-bolts playbook for using that specific pick.
- "qa": when they asked for a factual answer.
- "coach": when they want general guidance or a small playbook.

DEEP_DIVE CONTENT (for a selected book/item):
- Start with one sentence: why this is the right pick for their ask.
- Then a tight checklist of 5–7 steps to apply with entry-level employees in day-to-day work.
- Include ONE tiny template block (markdown) they can copy (e.g., a daily checklist or SOP skeleton).
- End with a single, specific next action question (Yes/No), e.g., "Want me to tailor this template for your [role/team]? (Yes/No)".

RULES:
- Keep language practical and direct. Avoid philosophy unless asked.
- For media, use EXACT keys: 'items' (array of {title, by?, why, takeaway}) and 'ask'.
- Never output a detailed tool plan without explicit user confirmation.
- Return ONLY valid JSON matching the expected schema.
`;

export async function composeReply({
  userText,
  candidates,
  toolCatalog,
  messages, // <-- NEW: full recent history for reference resolution
  model = process.env.OPENAI_CHAT_MODEL || "gpt-4o-mini",
}: {
  userText: string;
  candidates: Array<{ slug: string; title: string; score: number }>;
  toolCatalog: Record<string, { title: string; description: string; defaultSlots?: Record<string, any> }>;
  messages?: Array<{ role: "user" | "assistant"; content: string }>;
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
    history: (messages || []).slice(-12), // last 12 turns max
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
