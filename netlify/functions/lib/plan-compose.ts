// netlify/functions/lib/plan-compose.ts
import OpenAI from "openai";

export type Plan = {
  tool_slug: string;
  slots: Record<string, any>;
  message: string; // brief “what will happen” summary
};

const SYSTEM = `
You are configuring a tool the user explicitly approved. Fill sensible slots.
Return JSON { tool_slug, slots, message }. No fluff.
`;

export async function composeToolPlan({
  approvalText,
  tool_slug,
  toolMeta,
  model = process.env.OPENAI_CHAT_MODEL || "gpt-4o-mini",
}: {
  approvalText: string;
  tool_slug: string;
  toolMeta: any;
  model?: string;
}): Promise<Plan> {
  const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY! });
  const resp = await client.chat.completions.create({
    model,
    temperature: 0.2,
    response_format: { type: "json_object" },
    messages: [
      { role: "system", content: SYSTEM },
      { role: "user", content: JSON.stringify({ approvalText, tool: toolMeta }) },
    ],
  });
  const json = resp.choices?.[0]?.message?.content || "{}";
  return JSON.parse(json) as Plan;
}
