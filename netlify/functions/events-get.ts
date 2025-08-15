// netlify/functions/events-get.ts
import type { Handler } from "@netlify/functions";
import { createClient } from "@supabase/supabase-js";

const hasEnv =
  !!process.env.SUPABASE_URL && !!process.env.SUPABASE_SERVICE_ROLE_KEY;

const sb = hasEnv
  ? createClient(
      process.env.SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!
    )
  : null;

export const handler: Handler = async (event) => {
  const headers: Record<string, string> = {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-cache",
    "Access-Control-Expose-Headers": "X-Events-Count",
  };

  if (event.httpMethod !== "GET") {
    return { statusCode: 405, headers, body: JSON.stringify({ error: "Method Not Allowed" }) };
  }

  if (!sb) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: "no-supabase-env" }) };
  }

  const limit = Math.min(
    200,
    Math.max(1, parseInt(event.queryStringParameters?.limit || "50", 10) || 50)
  );

  const { data, error } = await sb
    .from("events")
    .select("id,ts,q,route,rag_count,rag_mode,model,reco_slug,duration_ms,ok,err")
    .order("id", { ascending: false })
    .limit(limit);

  if (error) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: error.message }) };
  }

  headers["X-Events-Count"] = String(data?.length || 0);
  return { statusCode: 200, headers, body: JSON.stringify(data, null, 2) };
};
