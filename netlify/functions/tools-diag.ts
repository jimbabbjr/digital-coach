import type { Handler } from "@netlify/functions";
import { createClient } from "@supabase/supabase-js";

export const handler: Handler = async () => {
  const url = process.env.SUPABASE_URL || "";
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || "";
  if (!url || !key) {
    return { statusCode: 200, body: JSON.stringify({ ok:false, reason:"no-sb-env" }) };
  }

  const sb = createClient(url, key);
  const out: any = { ok:true };

  try {
    const { data, error, status } = await sb
      .from("tool_docs")
      .select("slug,title,enabled,keywords,patterns")
      .eq("enabled", true)
      .limit(5);

    out.status = status;
    out.count = data?.length ?? 0;
    out.sample = (data || []).map((r: any) => ({
      slug: r.slug, title: r.title, enabled: r.enabled, keywords: r.keywords, patterns: r.patterns
    }));
    if (error) out.error = { code: (error as any).code, message: (error as any).message };
  } catch (e: any) {
    out.error = { name: e?.name, message: e?.message };
  }

  return { statusCode: 200, headers: { "content-type":"application/json" }, body: JSON.stringify(out, null, 2) };
};
