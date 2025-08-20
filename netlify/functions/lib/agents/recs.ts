// netlify/functions/lib/agents/recs.ts
import OpenAI from "openai";

type RecsAgentResult = {
  route: "qa";
  text: string;
  meta: { rag: number; ragMode: string; model: string };
};

const SYSTEM_PROMPT = [
  "You recommend practical books/podcasts/courses with nuts-and-bolts value.",
  "Prioritize step-by-step, operational content for day-to-day execution and training entry-level employees.",
  "Avoid philosophy unless explicitly requested.",
  "Return 3–5 picks max. For each: title, author, 1-line 'why this fits', and 1 concrete takeaway.",
  "Start with the recommendations. End with ONE short follow-up question to sharpen fit."
].join(" ");

export const RecsAgent = {
  route: "qa" as const,
  async handle({ userText }: { userText: string }): Promise<RecsAgentResult> {
    const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY! });

    const resp = await client.chat.completions.create({
      model: process.env.OPENAI_CHAT_MODEL || "gpt-4o-mini",
      temperature: 0.4,
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: userText }
      ],
    });

    const text = resp.choices?.[0]?.message?.content?.trim()
      || "Here are a few practical picks you can use immediately.";

    return {
      route: "qa",
      text,
      meta: { rag: 0, ragMode: "recs", model: String(resp.model || "gpt-4o-mini") },
    };
  }
};
