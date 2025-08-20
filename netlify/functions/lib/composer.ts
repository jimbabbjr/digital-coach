// netlify/functions/lib/composer.ts
import OpenAI from "openai";
import type { Reply } from "./reply-schema";

/**
 * Policy (model-facing):
 * - For recommendation asks (books/podcasts/articles/courses), return MODE "media_recs":
 *   - 'message' (>= 20 chars), practical tone
 *   - 'items': 3–5 entries {title, by?, why, takeaway}
 *   - 'ask': one short follow-up question
 * - If hints.selection_title is present, return MODE "deep_dive" for that item:
 *   - 5–7 concrete steps, one tiny copyable template block, and a yes/no next-action question.
 * - "offer_tool": suggest tools with ask-first language; never print setup plans.
 * - Use conversation history to resolve references.
 * - Output ONLY valid JSON for the chosen mode.
 */
const SYSTEM = `
You are a practical digital coach for small-business leaders.

MODES:
- "media_recs": when the user asks for books/podcasts/articles/courses. Provide 3–5 items with one-line 'why' and a concrete 'takeaway'. End with one short follow-up question under key 'ask'.
- "deep_dive": when the user selects or references an item from prior recommendations OR hints.selection_title is provided. Provide a focused playbook: 5–7 steps, one tiny copyable template block, and a yes/no next-action question.
- "offer_tool": when a tool would help. DO NOT print a setup plan. Suggest the tool with a brief value pitch and ALWAYS ask for confirmation first.
- "qa": factual answers.
- "coach": short playbook guidance.

RULES:
- If the current user message directly asks for books/podcasts/articles/courses, you should produce "media_recs".
- If hints.selection_title is present, you MUST produce "deep_dive" for that exact item.
- Read recent history to resolve references and avoid repeating previous lists.
- Keep language practical and direct.
- For "media_recs", use EXACT keys: 'items' (array of {title, by?, why, takeaway}) and 'ask'.
- 'message' must be at least 20 characters and never empty.
- Return ONLY valid JSON for the chosen mode.
`;

export async function composeReply({
  userText,
  candidates,
  toolCatalog,
  messages,
  hints,
  model = process.env.OPENAI_CHAT_MODEL || "gpt-4o-mini",
}: {
  userText: string;
  candidates: Array<{ slug: string; title: string; score: number }>;
  toolCatalog: Record<string, { title: string; description: string; defaultSlots?: Record<string, any> }>;
  messages?: Array<{ role: "user" | "assistant"; content: string }>;
  hints?: { selection_title?: string | null };
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
    history: (messages || []).slice(-12),
    hints: { selection_title: hints?.selection_title || null },
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
