import type { Handler } from "@netlify/functions";
import { createClient } from "@supabase/supabase-js";
import OpenAI from "openai";

const sb =
  process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY
    ? createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!)
    : null;

export const handler: Handler = async (event) => {
  if (event.httpMethod !== "POST") {
    return { statusCode: 405, body: "Method Not Allowed" };
  }
  try {
    if (!sb) throw new Error("Supabase not configured");
    const { title, url, content } = JSON.parse(event.body || "{}");
    if (!content || typeof content !== "string") {
      return { statusCode: 400, body: "Missing content" };
    }

    const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
    const embedModel = process.env.OPENAI_EMBED_MODEL || "text-embedding-3-small";
    const { data: emb } = await openai.embeddings.create({ model: embedModel, input: content.slice(0, 200_000) }); // safety cap
    const vec = emb[0]?.embedding;
    if (!vec) throw new Error("No embedding produced");

    const { error } = await sb.from("docs").insert({
      title: String(title || "").slice(0, 200),
      url: url || null,
      content,
      embedding: vec as unknown as any,
    });
    if (error) throw error;

    return { statusCode: 200, body: JSON.stringify({ ok: true }) };
  } catch (e: any) {
    return { statusCode: 500, body: JSON.stringify({ ok: false, error: String(e?.message || e) }) };
  }
};
