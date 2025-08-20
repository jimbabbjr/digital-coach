// netlify/functions/chat_v2.ts
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
    payload.q ?? payload.query ?? payload.text ?? payload.message ?? payload.prompt ?? payload.content ?? payload.input ?? "";
  if (direct && String(direct).trim()) return String(direct).trim();
  const fromMsgs = lastUserFromMessages(payload.messages || payload.history || []);
  if (fromMsgs) return fromMsgs.trim();
  const nested = payload?.data?.q ?? payload?.data?.text ?? payload?.data?.message ?? payload?.data?.prompt ?? "";
  return String(nested || "").trim();
}

/* ---------- selection detection from history ---------- */
function norm(s: string) {
  return String(s || "").toLowerCase().replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ").trim();
}
function extractTitlesFromAssistant(text: string): string[] {
  const titles: string[] = [];
  const boldLines = text.match(/-\s+\*\*([^*]+)\*\*/g) || [];
  for (const line of boldLines) {
    const m = /-\s+\*\*([^*]+)\*\*/.exec(line);
    if (m?.[1]) titles.push(m[1].trim());
  }
  for (const ln of text.split(/\r?\n/)) {
    const m = /^\s*-\s+(.+?)(?:\s+—|\s+\(|$)/.exec(ln);
    if (m?.[1]) titles.push(m[1].replace(/\*\*/g, "").trim());
  }
  return Array.from(new Set(titles));
}
function detectSelectionTitle(userText: string, messages: Array<{ role: "user" | "assistant"; content: string }>): string | null {
  const query = norm(userText).replace(/\b(the|a|an)\b/g, "").trim();
  if (!query || query.length < 3) return null;
  const lastAssistant = [...(messages || [])].reverse().find(m => m.role === "assistant")?.content || "";
  const titles = extractTitlesFromAssistant(String(lastAssistant || ""));
  if (!titles.length) return null;

  const qWords = query.split(" ").filter(Boolean);
  let best: { title: string; score: number } | null = null;
  for (const title of titles) {
    const tNorm = norm(title).replace(/\b(the|a|an)\b/g, "").trim();
    let score = 0;
    for (const w of qWords) if (w.length >= 3 && tNorm.includes(w)) score += 1;
    if (tNorm.includes(query)) score += 2;
    if (!best || score > best.score) best = { title, score };
  }
  if (best && best.score >= Math.max(2, Math.ceil(qWords.length / 2))) return best.title;
  return null;
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

/* ---------- renderers (markdown) ---------- */

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
  userText, messages, toolCatalog, candidates, hints,
}: {
  userText: string;
  messages: Array<{ role: "user" | "assistant"; content: string }>;
  toolCatalog: ToolCatalog;
  candidates: Array<{ slug: string; title: string; score: number }>;
  hints?: { selection_title?: string | null };
}) {
  const raw: Reply | any = await composeReply({
    userText,
    candidates,
    toolCatalog,
    messages,
    hints,
    model: process.env.OPENAI_CHAT_MODEL || "gpt-4o-mini",
  });
  return normalizeReply(raw);
}

async function processChatV2(payload: any) {
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

  // Selection detection from last assistant list
  const selectionTitle = detectSelectionTitle(userText, messages);

  // First pass
  let reply = await composeOnce({ userText, messages, toolCatalog, candidates, hints: { selection_title: selectionTitle } });

  // If we detected a selection but didn't get deep_dive, retry once
  if (selectionTitle && reply.mode !== "deep_dive") {
    reply = await composeOnce({ userText, messages, toolCatalog, candidates, hints: { selection_title: selectionTitle } });
  }

  // Route + render
  let route: "qa" | "coach" | "tools" = "qa";
  let text = "";

  switch (reply.mode) {
    case "media_recs":
      route = "qa"; text = renderMedia(reply); break;
    case "offer_tool":
      route = "tools"; text = renderOfferTool(reply); break;
    case "deep_dive":
      route = "coach"; text = reply.message; break;
    case "coach":
      route = "coach"; text = reply.message; break;
    case "qa":
    default:
      route = "qa"; text = reply.message; break;
  }

  if (!text || String(text).trim().length === 0) {
    text = selectionTitle
      ? `Here’s a concrete starter for **${selectionTitle}**:\n\n1) Define the critical steps.\n2) Draft a one-page checklist.\n3) Pilot with one entry-level role.\n4) Timebox revisions.\n5) Roll out team-wide.\n\nWant me to tailor a checklist template for your team? (Yes/No)`
      : "Okay.";
  }

  return { status: 200, json: { route, text } };
}

/* ---------- Netlify handlers ---------- */

export const handler: Handler = async (event) => {
  if (event.httpMethod !== "POST") return { statusCode: 405, body: "Method Not Allowed" };
  const payload = parseBody(event.body);
  try {
    const out = await processChatV2(payload);
    return { statusCode: out.status, body: JSON.stringify(out.json) };
  } catch (err: any) {
    return { statusCode: 500, body: JSON.stringify({ route: "qa", text: err?.message || "Internal error" }) };
  }
};

export default (async (req: Request) => {
  if (req.method !== "POST") return new Response(JSON.stringify({ route: "qa", text: "Method Not Allowed" }), { status: 405 });
  const payload = await req.json().catch(() => ({}));
  try {
    const out = await processChatV2(payload);
    return new Response(JSON.stringify(out.json), { status: out.status, headers: { "content-type": "application/json" } });
  } catch (err: any) {
    return new Response(JSON.stringify({ route: "qa", text: err?.message || "Internal error" }), { status: 500, headers: { "content-type": "application/json" } });
  }
}) as any;
