// netlify/functions/lib/render/plan.ts
export type PlanParams = {
  // kept for API compat, but we never auto-render plans
  allow?: boolean;
  confidence?: number;
  minConfidence?: number;
  mediaAsk?: boolean;
  cadence?: string;
  due_day?: string;
  due_time?: string;
  channel?: string;
  reminders?: number;
  anonymous?: boolean;
};

/** Ask-first suggestion. Never prints a deterministic plan. */
export function renderPlanForTool(
  tool: { title: string; outcome?: string | null },
  _p: PlanParams = {}
) {
  return `**${tool.title}** could help with this. Want me to set it up? (Yes / No)`;
}
