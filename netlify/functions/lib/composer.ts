// netlify/functions/lib/composer.ts
import OpenAI from "openai";
import type { Reply } from "./reply-schema";

/**
 * Policy (model-facing):
 * - For first-turn recommendation asks (books/podcasts/articles/courses), return MODE "media_recs".
 * - The message MUST be non-empty, practical, and >= 20 chars.
 * - media_recs: 3–5 items under key 'items' (each {title, by?, why, takeaway}) + one follow-up question under 'ask'.
 * - deep_dive: when user references a prior item by title/author/partial title; return a short, actionable playbook (5–7 steps + tiny template + yes/no next-action).
 * - offer_tool: suggest a tool ONLY with ask-first language; do not print plans.
 * - Use conversation history to resolve references.
 * - Output ONLY valid JSON for the selected mode.
 */
const SYSTEM = `
You are a practical digital coach for small-business leaders.

MODES:
- "media_recs": when the user asks for books/podcasts/articles/courses. Provide 3–5 items with one-line 'why' and a concrete 'takeaway'. End with a single short follow-up question under key 'ask'.
- "offer_tool": when a tool would help. DO NOT print a setup plan. Suggest the tool with a brief value pitch, propose minimal slots if helpful, and ALWAYS ask for confirmation first.
- "deep_dive": when the user selects or references an item from prior recommendations. Provide a focused, nuts-and-bolts playbook: 5–7 steps, one tiny copyable template block, and a yes/no next-action question.
- "qa": when they asked for a factual answer.
- "coach": when they want general guidance or a small playbook.

RULES:
- If the current user message directly asks for books/podcasts/articles/courses, respond with MODE "media_recs".
- Read history (last messages) to understand context and resolve references.
- Keep language practical and direct. Avoid philosophy unless asked.
- For "media_recs", use EXACT keys: 'items' (array of {title, by?, why, takeaway}) and 'ask'.
- The 'message' must never be empty and should be at least 20 characters.
- Return ONLY valid JSON for the chosen mode.
`;

export async function composeReply({
  userText,
  candidates,
  toolCatalog,
  messages,
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
    temperature: 0.2,
    response_format: { type: "json_object" },
    messages: [
      { role: "system", content: SYSTEM },
      { role: "user", content: JSON.stringify(context) },
    ],
  });

  const json = resp.choices?.[0]?.message?.content || "{}";
  return JSON.parse(json) as Reply;
}
