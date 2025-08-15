import type { Handler } from "@netlify/functions";

export const handler: Handler = async () => {
  const key = (process.env.OPENAI_API_KEY ?? "").trim();
  const supaUrl = (process.env.SUPABASE_URL ?? "").trim();
  const supaKey = (process.env.SUPABASE_SERVICE_ROLE_KEY ?? "").trim();

  const mask = (s: string) => (s ? `${s.slice(0, 4)}…${s.slice(-4)} (${s.length})` : "(empty)");

  return {
    statusCode: 200,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-cache" },
    body: JSON.stringify(
      {
        hasOpenAI: !!key,
        OPENAI_API_KEY: mask(key),
        SUPABASE_URL: supaUrl ? "set" : "(empty)",
        SUPABASE_SERVICE_ROLE_KEY: mask(supaKey),
        node: process.version,
        context: process.env.CONTEXT || null,
      },
      null,
      2
    ),
  };
};
