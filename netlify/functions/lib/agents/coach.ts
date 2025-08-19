// netlify/functions/lib/agents/coach.ts
import OpenAI from "openai";

type Span = { title?: string | null; url?: string | null; content: string; score?: number };

type HandleArgs = {
  userText: string;
  messages: any[];
  grounding?: Span[];             // <= RAG snippets for coach turns
};

function trimBlock(s: string, max = 1200): string {
  s = String(s || "");
  if (s.length <= max) return s;
  return s.slice(0, max) + " …";
}

export const CoachAgent = {
  async handle({ userText, grounding = [] }: HandleArgs): Promise<{
    text: string;
    route: "coach";
    meta: { rag?: number; ragMode?: string | null; model?: string | null };
  }> {
    const model = process.env.OPENAI_API_KEY ? (process.env.OPENAI_CHAT_MODEL || "gpt-4o-mini") : null;

    // Build a compact CONTEXT block from spans (titles help anchor the principles)
    const ctx = grounding.slice(0, 3).map((s, i) => {
      const head =
        (s.title ? `#${i + 1} ${s.title}` : `#${i + 1} Principle`) +
        (s.url ? `  (${s.url})` : "");
      return `${head}\n${trimBlock(s.content || "", 900)}`;
    }).join("\n\n---\n\n");

    const contextNote = ctx
      ? `Use ONLY the following internal context to ground your advice.\n\n${ctx}`
      : `There is no additional context; use generic leadership/ops best practices.`;

    // If no API key, return a deterministic, grounded-ish template
    if (!model) {
      const groundedBits = grounding.length
        ? `\n\n_Grounded in:_ ${(grounding[0].title || "internal principles")}`
        : "";
      const text =
        `Here’s a concise plan:\n\n` +
        `1) Clarify the outcome and constraints.\n` +
        `2) Identify blockers and decide the next step.\n` +
        `3) Communicate expectations and cadence.\n` +
        `4) Close the loop and inspect results.${groundedBits}`;
      return { text, route: "coach", meta: { rag: grounding.length, ragMode: "coach-ground", model: null } };
    }

    // LLM prompt (action-oriented + grounded)
   const wantGrounding = grounding.length > 0;

const system = [
  "You are an action-oriented leadership/ops coach.",
  wantGrounding ? "Root your guidance in the CONTEXT block. Do NOT invent facts outside it." 
                : "There is no context; use generic leadership best practices. Do NOT add a 'Grounded in' section.",
  "Format:",
  "- Brief direction (2–3 sentences).",
  "- A numbered action plan (4–6 steps, imperative).",
  wantGrounding ? "- A tiny 'Grounded in' section listing 1–2 principle titles." : "",
].join("\n");

    const user =
      [
        `Question: ${userText}`,
        "",
        "CONTEXT:",
        contextNote,
      ].join("\n");

    const oai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY! });
    const resp = await oai.chat.completions.create({
      model,
      temperature: 0.3,
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
    });

    const answer = resp.choices[0]?.message?.content?.trim() || "Here’s a concise plan.";
    return {
      text: answer,
      route: "coach",
      meta: { rag: grounding.length, ragMode: "coach-ground", model },
    };
  },
};
