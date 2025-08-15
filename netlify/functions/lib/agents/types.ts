// lib/agents/types.ts
export type AgentId = "coach"|"qa"|"tools";
export type AgentInput = {
  userText: string;
  messages: Array<{role:"user"|"assistant"|"system", content:string}>;
  context?: string|null;
};
export type AgentOutput = {
  text: string;
  route: AgentId;
  reco?: boolean;
  meta?: Record<string, any>;
};
export interface Agent {
  id: AgentId;
  handle(input: AgentInput): Promise<AgentOutput>;
}
