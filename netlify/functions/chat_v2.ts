// netlify/functions/chat_v2.ts
/* eslint-disable @typescript-eslint/no-explicit-any */

import type { Handler } from "@netlify/functions";
import { rankTools } from "./lib/tool-select";
import { composeReply } from "./lib/composer";
import { composeToolPlan } from "./lib/plan-compose";
import type { Reply } from "./lib/reply-schema";

/* ---------- helpers ---------- */

function isAffirmative(s: string) {
  const x = String(s || "").toLowerCase();
  return /\b(yes|yep|sure|sounds good|do it|let'?s (go|try|do)( it)?|ok(ay)?|go ahead|please do)\b/.test(x);
}

function isMediaAsk(s: string) {
  return /\b(book|books|author|reading\s*list|recommend( me|ation)?s?|podcast|article|course|courses?)\b/i.test(
    String(s || "")
  );
}

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
  // tolerate array of segments (OpenAI-style)
  if (Array.isArray(c)) return c.map((seg) => (seg?.text ?? seg?.content ?? "")).join(" ").trim();
  return String(c);
}

function extractUserText(payload: any): string {
  // accept a wide variety of UI payloads
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

  // fallback to messages
  const fromMsgs = lastUserFromMessages(payload.messages || payload.history || []);
  if (fromMsgs) return fromMsgs.trim();

  // some UIs send { data: { q: ... } }
  const nested =
    payload?.data?.q ??
    payload?.data?.text ??
    payload?.data?.message ??
    payload?.data?.prompt ??
    "";
  return String(nested || "").trim();
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

/* ---------- renderers (no hard-coded plans) ---------- */

function renderMedia(reply: Extract<Reply, { mode: "media_recs" }>) {
  const items = (reply.items || [])
    .map((i) => `- **${i.title}**${i.by ? ` (${i.by})` : ""} — ${i.why} _Takeaway:_ ${i.takeaway}`)
    .join("\n");
  const tail = reply.ask ? `\n\n${reply.ask}` : "";
  return `${reply.message}\n\n${items}${tail}`.trim();
}

function renderOfferTool(reply: Extract<Reply, { mode: "offer_tool" }>) {
  const pct = Math.round((reply.confidence ?? 0) * 100);
  const conf = Number.isFinite(pct) && pct > 0 ? ` (confidence ${pct}%)` : "";
  return `${reply.message}\n\n**${reply.tool_slug}**${conf}\n${reply.confirm_cta}`;
}

/* ---------- core ---------- */

async function processChatV2(payload: any) {
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

  // explicit confirmation path (optional)
  if (confirmToolSlug) {
    const meta = toolCatalog[confirmToolSlug] || { title: confirmToolSlug, description: "" };
    const plan = await composeToolPlan({
      approvalText: approvalText || userText,
      tool_slug: confirmToolSlug,
      toolMeta: meta,
    });
    const msg = plan.message || `I'll configure **${meta.title || confirmToolSlug}** with: ${JSON.stringify(plan.slots)}`;
    return {
      status: 200,
      json: {
        route: "tools",
        impl: "composer-v1",
        text: msg,
        reco: false,
        recoSlug: confirmToolSlug,
        plan,
        meta: { composer: "composeToolPlan", model: process.env.OPENAI_CHAT_MODEL || "gpt-4o-mini" },
      },
    };
  }

  const reply: Reply = await composeReply({
    userText,
    candidates,
    toolCatalog,
    model: process.env.OPENAI_CHAT_MODEL || "gpt-4o-mini",
  });

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
      // ask-first: never auto-reco/execute
      reco = false;
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

  // no sticky tool unless user explicitly affirmed
  const lastUser = [...messages].reverse().find((m) => m.role === "user")?.content ?? "";
  const allowSticky = isAffirmative(lastUser);
  if (!allowSticky) {
    // keep reco=false
  }

  const meta = {
    composer: "composeReply",
    model: process.env.OPENAI_CHAT_MODEL || "gpt-4o-mini",
    isMediaAsk: isMediaAsk(userText),
  };

  return {
    status: 200,
    json: { route, impl: "composer-v1", text, reco, recoSlug, candidates, reply, meta, inputUsed: userText },
  };
}

/* ---------- Netlify handlers ---------- */

export const handler: Handler = async (event) => {
  if (event.httpMethod !== "POST") return { statusCode: 405, body: "Method Not Allowed" };
  const payload = parseBody(event.body);
  try {
    const out = await processChatV2(payload);
    return { statusCode: out.status, body: JSON.stringify(out.json) };
  } catch (err: any) {
    return { statusCode: 500, body: JSON.stringify({ error: err?.message || "Internal error" }) };
  }
};

export default (async (req: Request) => {
  if (req.method !== "POST") return new Response("Method Not Allowed", { status: 405 });
  const payload = await req.json().catch(() => ({}));
  try {
    const out = await processChatV2(payload);
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
