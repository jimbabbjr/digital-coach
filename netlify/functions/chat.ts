// netlify/functions/chat.ts
/* eslint-disable @typescript-eslint/no-explicit-any */

import type { Handler } from "@netlify/functions";
import { rankTools } from "./lib/tool-select";
import { composeReply } from "./lib/composer";
import { composeToolPlan } from "./lib/plan-compose";
import type { Reply } from "./lib/reply-schema";

/* ---------- helpers ---------- */

function parseBody(raw: any) {
  if (!raw) return {};
  try { return typeof raw === "string" ? JSON.parse(raw) : raw; }
  catch { return {}; }
}

function lastUserFromMessages(messages: any[]): string {
  if (!Array.isArray(messages)) return "";
  const u = [...messages].reverse().find((m) => m?.role === "user");
  const c = u?.content;
  if (!c) return "";
  if (typeof c === "string") return c;
  if (Array.isArray(c)) return c.map((seg) => (seg?.text ?? seg?.content ?? "")).join(" ").trim();
  return String(c);
}

function extractUserText(payload: any): string {
  const direct =
    payload.q ??
    payload.query ??
    payload.text ??
    payload.message ??
    payload.prompt ??
    payload.content ??
    payload.input ??
    "";
  if (direct && String(direct).trim()) return String(direct).trim();
  const fromMsgs = lastUserFromMessages(payload.messages || payload.history || []);
  if (fromMsgs) return fromMsgs.trim();
  const nested =
    payload?.data?.q ??
    payload?.data?.text ??
    payload?.data?.message ??
    payload?.data?.prompt ??
    "";
  return String(nested || "").trim();
}

function isAffirmative(s: string) {
  const x = String(s || "").toLowerCase();
  return /\b(yes|yep|sure|sounds good|do it|let'?s (go|try|do)( it)?|ok(ay)?|go ahead|please do)\b/.test(x);
}

function isMediaAsk(s: string) {
  return /\b(book|books|author|reading\s*list|recommend( me|ation)?s?|podcast|article|course|courses?)\b/i.test(
    String(s || "")
  );
}

/* ---------- normalizer ---------- */

type AnyReply = any;

function normalizeReply(raw: AnyReply) {
  const r = raw || {};
  const mode = r.mode;

  if (mode === "media_recs") {
    const itemsSrc = r.items ?? r.recommendations ?? r.recs ?? [];
    const items = (Array.isArray(itemsSrc) ? itemsSrc : []).map((it: any) => ({
      title: it.title ?? it.name ?? "",
      by: it.by ?? it.author ?? it.writer ?? undefined,
      why: it.why ?? it.reason ?? it.why_this ?? "",
      takeaway: it.takeaway ?? it.key_takeaway ?? it.tip ?? "",
    }));
    const ask = r.ask ?? r.follow_up ?? r.followup ?? undefined;
    const message =
      r.message ??
      r.header ??
      "Here are practical, nuts-and-bolts picks you can use immediately:";
    return { mode: "media_recs", message, items, ask };
  }

  if (mode === "offer_tool") {
    return {
      mode: "offer_tool",
      tool_slug: r.tool_slug ?? r.slug ?? r.tool ?? "",
      confidence: typeof r.confidence === "number" ? r.confidence : (r.score ?? 0),
      slots: r.slots ?? r.defaults ?? {},
      message:
        r.message ??
        r.pitch ??
        "This tool looks like a good fit for this problem.",
      confirm_cta: r.confirm_cta ?? "Want me to set this up? (Yes / No)",
      requires_confirmation: true,
    };
  }

  return {
    mode: mode === "coach" ? "coach" : "qa",
    message: String(r.message ?? r.text ?? "").trim() || "Got it.",
  };
}

/* ---------- tool catalog ---------- */

type ToolCatalog = Record<string, { title: string; description: string; defaultSlots?: Record<string, any> }>;
function asToolArray(catalog: ToolCatalog) {
  return Object.entries(catalog || {}).map(([slug, t]) => ({
    slug,
    title: t.title || slug,
    description: t.description || "",
  }));
}

/* ---------- renderers ---------- */

function renderMedia(reply: any) {
  const header =
    reply.message ||
    "Here are practical, nuts-and-bolts picks you can use immediately:";
  const list = Array.isArray(reply.items) ? reply.items : [];
  const lines = list.map((i: any) => {
    const by = i.by ? ` (${i.by})` : "";
    const why = i.why ? ` — ${i.why}` : "";
    const take = i.takeaway ? ` _Takeaway:_ ${i.takeaway}` : "";
    return `- **${i.title || "Untitled"}**${by}${why}${take}`;
  });
  const ask = reply.ask ? `\n\n${reply.ask}` : "";
  return `${header}\n\n${lines.join("\n")}${ask}`.trim();
}

function renderOfferTool(reply: any) {
  const pct = Math.round((reply.confidence ?? 0) * 100);
  const conf = Number.isFinite(pct) && pct > 0 ? ` (confidence ${pct}%)` : "";
  return `${reply.message}\n\n**${reply.tool_slug}**${conf}\n${reply.confirm_cta}`;
}

/* ---------- core ---------- */

async function processChat(payload: any) {
  const userText = extractUserText(payload);
  const messages: Array<{ role: "user" | "assistant"; content: string }> = payload.messages ?? [];
  const toolCatalog: ToolCatalog = payload.toolCatalog ?? {};
  const confirmToolSlug: string | null = payload.confirm_tool_slug ?? null;
  const approvalText: string | null = payload.approval_text ?? null;

  if (!userText && !confirmToolSlug) {
    return { status: 400, json: { error: "Missing 'q' (user text)" } };
  }

  const tools = asToolArray(toolCatalog);
  const candidates = tools.length ? await rankTools(userText, tools) : [];

  if (confirmToolSlug) {
    const meta = toolCatalog[confirmToolSlug] || { title: confirmToolSlug, description: "" };
    const plan = await composeToolPlan({
      approvalText: approvalText || userText,
      tool_slug: confirmToolSlug,
      toolMeta: meta,
    });
    const msg = plan.message || `I'll configure **${meta.title || confirmToolSlug}** with: ${JSON.stringify(plan.slots)}`;
    const body = {
      route: "tools",
      impl: "composer-v1",
      text: msg,
      reco: false,
      recoSlug: confirmToolSlug,
      plan,
      meta: { composer: "composeToolPlan", model: process.env.OPENAI_CHAT_MODEL || "gpt-4o-mini" },
    };
    const debug = Boolean(payload?.debug || payload?.__debug || process.env.API_DEBUG);
    return { status: 200, json: debug ? body : { route: body.route, text: body.text } };
  }

  const rawReply = await composeReply({
    userText,
    candidates,
    toolCatalog,
    model: process.env.OPENAI_CHAT_MODEL || "gpt-4o-mini",
  });

  const reply = normalizeReply(rawReply);

  let route: "qa" | "coach" | "tools" = "qa";
  let text = "";
  let reco = false;
  let recoSlug: string | null = null;

  switch (reply.mode) {
    case "media_recs":
      route = "qa";
      text = renderMedia(reply);
      break;
    case "offer_tool":
      route = "tools";
      text = renderOfferTool(reply);
      reco = false; // ask-first only
      recoSlug = reply.tool_slug;
      break;
    case "coach":
      route = "coach";
      text = reply.message;
      break;
    case "qa":
    default:
      route = "qa";
      text = reply.message;
      break;
  }

  if (!text || String(text).trim().length === 0) {
    text = reply.message || "Okay.";
  }

  const lastUser = [...messages].reverse().find((m) => m.role === "user")?.content ?? "";
  const allowSticky = isAffirmative(lastUser);
  if (!allowSticky) {
    // keep reco=false
  }

  const base = {
    route,
    impl: "composer-v1",
    text,
    reco,
    recoSlug,
    candidates,
    reply,
    meta: { composer: "composeReply", model: process.env.OPENAI_CHAT_MODEL || "gpt-4o-mini", isMediaAsk: isMediaAsk(userText) },
    inputUsed: userText,
  };

  const debug = Boolean(payload?.debug || payload?.__debug || process.env.API_DEBUG);
  return { status: 200, json: debug ? base : { route: base.route, text: base.text } };
}

/* ---------- Netlify handlers ---------- */

export const handler: Handler = async (event) => {
  if (event.httpMethod !== "POST") return { statusCode: 405, body: "Method Not Allowed" };
  const payload = parseBody(event.body);
  try {
    const out = await processChat(payload);
    return { statusCode: out.status, body: JSON.stringify(out.json) };
  } catch (err: any) {
    return { statusCode: 500, body: JSON.stringify({ error: err?.message || "Internal error" }) };
  }
};

export default (async (req: Request) => {
  if (req.method !== "POST") return new Response("Method Not Allowed", { status: 405 });
  const payload = await req.json().catch(() => ({}));
  try {
    const out = await processChat(payload);
    return new Response(JSON.stringify(out.json), {
      status: out.status,
      headers: { "content-type": "application/json" },
    });
  } catch (err: any) {
    return new Response(JSON.stringify({ error: err?.message || "Internal error" }), {
      status: 500,
      headers: { "content-type": "application/json" },
    });
  }
}) as any;
