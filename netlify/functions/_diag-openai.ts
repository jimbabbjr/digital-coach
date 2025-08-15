// netlify/functions/_diag-openai.ts
import type { Handler } from "@netlify/functions";
import OpenAI from "openai";

export const handler: Handler = async () => {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "Access-Control-Expose-Headers": "X-Err, X-Err-Message",
  };

  try {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) throw new Error("OPENAI_API_KEY missing");

    const model = process.env.OPENAI_CHAT_MODEL || "gpt-4o-mini"; // widely available
    const oai = new OpenAI({ apiKey });

    const r = await oai.responses.create({
      model,
      input: "Say 'pong' once."
    });

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        ok: true,
        modelUsed: r.model ?? model,
        text: r.output_text?.slice(0, 80) ?? null,
      }),
    };
  } catch (e: any) {
    headers["X-Err"] = String(e?.error?.type ?? e?.name ?? "unknown");
    headers["X-Err-Message"] = String(e?.error?.message ?? e?.message ?? "");
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ ok: false }),
    };
  }
};
