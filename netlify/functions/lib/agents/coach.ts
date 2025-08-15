// lib/agents/coach.ts
import { Agent } from "./types";
import OpenAI from "openai";
const oai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY! });

const SYSTEM = `You are a sharp, practical coach... [same as above]`;

export const CoachAgent: Agent = {
  id: "coach",
  async handle({ userText, messages }) {
    const input = [{ role: "system", content: SYSTEM }, ...messages, { role: "user", content: userText }];
    const ai = await oai.responses.create({ model: "gpt-4.1-mini", input });
    return { text: ai.output_text ?? "", route: "coach" };
  }
};
