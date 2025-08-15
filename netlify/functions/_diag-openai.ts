// netlify/functions/_diag-openai.ts
import type { Handler } from "@netlify/functions";
import OpenAI from "openai";

export const handler: Handler = async () => {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "Access-Control-Expose-Headers": "X-Err, X-Err-Message, X-Req-Id, X-Status",
  };

  try {
    const apiKey = (process.env.OPENAI_API_KEY || "").trim(); // <-- trim whitespace/newlines
    if (!apiKey) throw new Error("OPENAI_API_KEY missing");

    const model = (process.env.OPENAI_CHAT_MODEL || "gpt-4o-mini").trim();

    const oai = new OpenAI({ apiKey });
    const r = await oai.responses.create({ model, input: "Say 'pong' once." });

    headers["X-Req-Id"] = String((r as any)._request_id || ""); // SDK exposes _request_id
    headers["X-Status"] = "200";

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        ok: true,
        keyPreview: `${apiKey.slice(0,7)}…${apiKey.slice(-4)} (len ${apiKey.length})`,
        modelUsed: r.model ?? model,
        text: r.output_text?.slice(0, 80) ?? null,
      }),
    };
  } catch (e: any) {
    const status = e?.status ?? 500;
    headers["X-Status"] = String(status);
    headers["X-Err"] = String(e?.name ?? e?.error?.type ?? "unknown");
    headers["X-Err-Message"] = String(e?.message ?? e?.error?.message ?? "");
    if (e?.request_id) headers["X-Req-Id"] = String(e.request_id);

    return { statusCode: 500, headers, body: JSON.stringify({ ok: false }) };
  }
};
