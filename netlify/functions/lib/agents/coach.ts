// netlify/functions/lib/agents/coach.ts
import OpenAI from "openai";
// If you have a shared Msg type, you can import it. Otherwise this local type is fine.
type Msg = { role: "user" | "assistant" | "system"; content: string };

const oai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY! });

const SYSTEM = `You are a sharp, practical coach. Be concise, actionable, and upbeat.
- Focus on the user's goals, constraints, and next best step.
- Prefer checklists, short templates, and concrete examples over theory.
- Avoid brand or third-party tool endorsements unless the user asks.
- Keep replies scannable with short sections or bullets.
`;

// We intentionally do NOT annotate with a custom Agent interface,
// because your current Agent type doesn’t include `route`.
export const CoachAgent = {
  route: "coach" as const,

  async handle({
    userText,
    messages,
  }: {
    userText: string;
    messages: Msg[];
  }) {
    // Build a clean message list for Chat Completions
    const chatMessages: Msg[] = [
      { role: "system", content: SYSTEM },
      ...messages
        .filter((m) => m && typeof m.content === "string")
        .map((m) => ({
          role: (m.role === "user" || m.role === "assistant" || m.role === "system"
            ? m.role
            : "user") as Msg["role"],
          content: String(m.content),
        })),
      { role: "user", content: String(userText) },
    ];

    const model = process.env.OPENAI_COACH_MODEL || "gpt-4o-mini";

    const completion = await oai.chat.completions.create({
      model,
      messages: chatMessages,
      temperature: 0.3,
    });

    const text =
      completion.choices?.[0]?.message?.content?.trim() ??
      "Okay! What would you like coaching on today?";

    return {
      text,
      route: "coach" as const,
      meta: { model },
    };
  },
};

export type CoachAgentType = typeof CoachAgent;
