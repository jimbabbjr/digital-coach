// netlify/functions/lib/agents/tools.ts
import {
  getToolRegistry,
  matchToolByIntent,
  formatTryLine,
} from "../tools";

export const ToolsAgent = {
  route: "tools" as const,

  async handle({
    userText,
    messages = [],
  }: {
    userText: string;
    messages?: Array<{ role: string; content: string }>;
  }) {
    const docs = await getToolRegistry();
    const pick = matchToolByIntent(userText, docs);

    const bullets = [
      "**Make it personal:** Short self-check-ins.",
      "**Keep it brief:** Wins, challenges, next focus.",
      "**Be consistent:** Same day/time each week.",
    ];
    let text = bullets.map((b) => `- ${b}`).join("\n");

    let reco = false;
    let recoSlug: string | null = null;
    if (pick) {
      text += `\n\n${formatTryLine(pick)}`;
      reco = true;
      recoSlug = pick.slug;
    }

    return {
      route: "tools",
      text,
      reco,
      meta: { rag: 0, ragMode: null, model: null, recoSlug },
    };
  },
};
