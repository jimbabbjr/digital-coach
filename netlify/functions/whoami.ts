import type { Handler } from "@netlify/functions";

export const handler: Handler = async () => {
  const env = process.env;
  const out = {
    ok: true,
    OPENAI_API_KEY: !!env.OPENAI_API_KEY,
    SUPABASE_URL: !!env.SUPABASE_URL,
    SUPABASE_SERVICE_ROLE_KEY: !!env.SUPABASE_SERVICE_ROLE_KEY,
    VITE_SUPABASE_URL: !!env.VITE_SUPABASE_URL,
    VITE_SUPABASE_ANON_KEY: !!env.VITE_SUPABASE_ANON_KEY,
    OPENAI_EMBED_MODEL: env.OPENAI_EMBED_MODEL || null,
    NODE_VERSION: env.NODE_VERSION || null,
  };
  return {
    statusCode: 200,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(out, null, 2),
  };
};
