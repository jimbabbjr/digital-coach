import { Handler } from "@netlify/functions";
import { createClient } from "@supabase/supabase-js";

const sb = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);

export const handler: Handler = async () => {
  const { data, error } = await sb
    .from("events")
    .select("ts,q,route,rag_count,rag_mode,model,reco_slug,duration_ms,ok,err")
    .order("id", { ascending: false })
    .limit(50);
  if (error) return new Response("err", { status: 500 });
  return new Response(JSON.stringify(data, null, 2), {
    headers: { "Content-Type": "application/json" }
  });
};
