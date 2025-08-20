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

function isMediaAsk(s: string) {
  const t = String(s || "").toLowerCase();
  return /\b(book|books|author|reading\s*list|recommend(ation| me)?s?|title|read|reading|podcast|article|course|courses?)\b/.test(t);
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
    const ask = r.ask ?? r.follow_up ?? r.followUpQuestion ?? r.followup ?? undefined;
    const msgCandidate = (r.message ?? r.header ?? "");
    const message = String(msgCandidate).trim() || "Here are practical, nuts-and-bolts picks you can use immediately:";
    return { mode: "media_recs", message, items, ask };
  }

  if (mode === "offer_tool") {
    const pitch = (r.message ?? r.pitch ?? "");
    const message = String(pitch).trim() || "This tool looks like a good fit for this problem.";
    return {
      mode: "offer_tool",
      tool_slug: r.tool_slug ?? r.slug ?? r.tool ?? "",
      confidence: typeof r.confidence === "number" ? r.confidence : (r.score ?? 0),
      slots: r.slots ?? r.defaults ?? {},
      message,
      confirm_cta: r.confirm_cta ?? "Want me to set this up? (Yes / No)",
      requires_confirmation: true,
    };
  }

  if (mode === "deep_dive") {
    const base = String((r.message ?? "")).trim();
    return { mode: "deep_dive", message: base || "Here’s a concrete next-step plan you can run today." };
  }

  const base = String((r.message ?? r.text ?? "")).trim();
  return { mode: mode === "coach" ? "coach" : "qa", message: base || "Got it." };
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

/* ---------- render (markdown) ---------- */

function renderMedia(reply: any) {
  const header = reply.message || "Here are practical, nuts-and-bolts picks you can use immediately:";
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

async function composeOnce({
  userText, messages, toolCatalog, candidates,
}: {
  userText: string;
  messages: Array<{ role: "user" | "assistant"; content: string }>;
  toolCatalog: ToolCatalog;
  candidates: Array<{ slug: string; title: string; score: number }>;
}) {
  const raw: Reply | any = await composeReply({
    userText,
    candidates,
    toolCatalog,
    messages,
    model: process.env.OPENAI_CHAT_MODEL || "gpt-4o-mini",
  });
  return normalizeReply(raw);
}

async function processChat(payload: any) {
  const userText = extractUserText(payload);
  const messages: Array<{ role: "user" | "assistant"; content: string }> = payload.messages ?? [];
  const toolCatalog: ToolCatalog = payload.toolCatalog ?? {};
  const confirmToolSlug: string | null = payload.confirm_tool_slug ?? null;
  const approvalText: string | null = payload.approval_text ?? null;

  if (!userText && !confirmToolSlug) {
    return { status: 400, json: { route: "qa", text: "Please type your question." } };
  }

  const tools = asToolArray(toolCatalog);
  const candidates = tools.length ? await rankTools(userText, tools) : [];

  // optional confirmation flow (lean response)
  if (confirmToolSlug) {
    const meta = toolCatalog[confirmToolSlug] || { title: confirmToolSlug, description: "" };
    const plan = await composeToolPlan({
      approvalText: approvalText || userText,
      tool_slug: confirmToolSlug,
      toolMeta: meta,
    });
    const msg = plan.message || `I'll configure **${meta.title || confirmToolSlug}** with: ${JSON.stringify(plan.slots)}`;
    return { status: 200, json: { route: "tools", text: msg } };
  }

  // 1) First pass
  let reply = await composeOnce({ userText, messages, toolCatalog, candidates });

  // 2) Self-heal once: if it's clearly a media ask but not media_recs, retry
  if (isMediaAsk(userText) && reply.mode !== "media_recs") {
    reply = await composeOnce({ userText, messages, toolCatalog, candidates });
  }

  // 3) Route + render
  let route: "qa" | "coach" | "tools" = "qa";
  let text = "";

  switch (reply.mode) {
    case "media_recs":
      route = "qa";
      text = renderMedia(reply);
      break;
    case "offer_tool":
      route = "tools";
      text = renderOfferTool(reply);
      break;
    case "deep_dive":
      route = "coach";
      text = reply.message;
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
    // last-resort safety for obviously media asks
    if (isMediaAsk(userText)) {
      text =
        "Here are practical, nuts-and-bolts picks you can use immediately:\n\n" +
        "- **The Checklist Manifesto** (Atul Gawande) — Use checklists to standardize daily work. _Takeaway:_ Write a one-page checklist for each recurring task.\n" +
        "- **Getting Things Done** (David Allen) — Capture/clarify/organize for reliable follow-through. _Takeaway:_ Make a shared 'Next Actions' list for the team.\n" +
        "- **Scrum: The Art of Doing Twice the Work in Half the Time** (Jeff Sutherland) — Lightweight cadence for execution. _Takeaway:_ Try a 10-minute standup and a weekly demo.\n\n" +
        "Which one do you want to start with?";
    } else {
      text = "Okay.";
    }
  }

  return { status: 200, json: { route, text } };
}

/* ---------- Netlify handlers ---------- */

export const handler: Handler = async (event) => {
  if (event.httpMethod !== "POST") return { statusCode: 405, body: "Method Not Allowed" };
  const payload = parseBody(event.body);
  try {
    const out = await processChat(payload);
    return { statusCode: out.status, body: JSON.stringify(out.json) };
  } catch (err: any) {
    return { statusCode: 500, body: JSON.stringify({ route: "qa", text: err?.message || "Internal error" }) };
  }
};

export default (async (req: Request) => {
  if (req.method !== "POST") return new Response(JSON.stringify({ route: "qa", text: "Method Not Allowed" }), { status: 405 });
  const payload = await req.json().catch(() => ({}));
  try {
    const out = await processChat(payload);
    return new Response(JSON.stringify(out.json), {
      status: out.status,
      headers: { "content-type": "application/json" },
    });
  } catch (err: any) {
    return new Response(JSON.stringify({ route: "qa", text: err?.message || "Internal error" }), {
      status: 500,
      headers: { "content-type": "application/json" },
    });
  }
}) as any;
