// netlify/functions/chat_v2.ts
import type { Handler } from "@netlify/functions";
import { createClient } from "@supabase/supabase-js";

import { route as pickRoute } from "./lib/agents/router";
import { QaAgent } from "./lib/agents/qa";
import { CoachAgent } from "./lib/agents/coach";
// If you ever want to short-circuit tools turns, you can import ToolsAgent and swap it in.
// import { ToolsAgent } from "./lib/agents/tools";

import { buildAllowlist, stripAllTryLines, removeExternalToolMentions } from "./lib/sanitize";
import { getCandidatesFromTools, scoreRouteLLM } from "./lib/agents/router_v2";
import { retrieveSpans } from "./lib/retrieve";

// ---------------------------
// Supabase (optional; telemetry & registry & session memory)
// ---------------------------
const sb =
  process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY
    ? createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!)
    : null;

// ---------------------------
// Types & helpers
// ---------------------------
type PlanParams = {
  cadence?: "weekly" | "biweekly" | "monthly" | "daily";
  due_day?: string;   // e.g., "Friday"
  due_time?: string;  // e.g., "3pm"
  channel?: "slack" | "email" | "app";
  anonymous?: boolean;
  reminders?: 0 | 1 | 2;
};

function formatTryLine(t: { title: string }) {
  return `Try: ${t.title}`;
}

function renderPlanForTool(tool: { title: string; outcome?: string | null }, p: PlanParams = {}) {
  const outcome = tool.outcome || "reliable weekly signal without manual chasing";
  const cadence = p.cadence || "weekly";
  const day = p.due_day || (cadence === "weekly" ? "Friday" : undefined);
  const time = p.due_time || "3pm";
  const channel = p.channel ? p.channel.charAt(0).toUpperCase() + p.channel.slice(1) : "App";
  const rem = typeof p.reminders === "number" ? p.reminders : 1;
  const anon = p.anonymous ? " (anonymous collection enabled)" : "";

  return [
    `Here’s the fastest path using **${tool.title}**:`,
    "",
    `- **Set the rhythm:** ${
      cadence === "weekly"
        ? "Every week"
        : cadence === "biweekly"
        ? "Every other week"
        : cadence.charAt(0).toUpperCase() + cadence.slice(1)
    }${day ? ` on ${day}` : ""} at ${time}.`,
    "- **Use the built-in template:** Wins, blockers, next week.",
    `- **Nudges:** ${rem} reminder${rem === 1 ? "" : "s"} before the deadline via ${channel}.`,
    `- **Model the habit:** Post your own update first${anon}.`,
    "- **Close the loop:** Share highlights to show value.",
    "",
    `Result: ${outcome}.`,
  ].join("\n");
}

// --- text utils ---
function norm(s: string) {
  return String(s || "")
    .toLowerCase()
    .replace(/\btool\b/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}
function tokenOverlap(a: string, b: string): number {
  const A = new Set(norm(a).split(" ").filter(Boolean));
  const B = new Set(norm(b).split(" ").filter(Boolean));
  if (!A.size || !B.size) return 0;
  let overlap = 0;
  for (const w of A) if (B.has(w)) overlap++;
  return overlap / Math.max(A.size, B.size);
}
function toList(x: unknown): string[] {
  if (Array.isArray(x)) return x.map((v) => String(v).trim()).filter(Boolean);
  if (x == null) return [];
  const s = String(x);
  if (s.startsWith("{") && s.endsWith("}")) {
    return s
      .slice(1, -1)
      .split(",")
      .map((v) => v.trim())
      .filter(Boolean);
  }
  return s.split(",").map((v) => v.trim()).filter(Boolean);
}
function kebab(s?: string | null) {
  return String(s ?? "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}
function coalesce<T>(...vals: T[]): T | undefined {
  for (const v of vals) if (v !== undefined && v !== null && String(v) !== "") return v;
  return undefined;
}
function isEnabledRow(row: any): boolean {
  const v = row?.enabled ?? row?.is_enabled ?? row?.active ?? row?.is_active ?? row?.status;
  if (typeof v === "boolean") return v;
  if (typeof v === "string") return ["1", "true", "t", "y", "yes", "active", "enabled"].includes(v.toLowerCase());
  if (typeof v === "number") return v > 0;
  return true;
}

// --- cookie helpers ---
function getCookie(name: string, cookieHeader?: string): string | null {
  const ck = cookieHeader || "";
  const re = new RegExp(`(?:^|;\\s*)${name}=([^;]*)`);
  const m = ck.match(re);
  return m ? decodeURIComponent(m[1]) : null;
}
function setCookie(
  headers: Record<string, string>,
  name: string,
  value: string,
  attrs = "; Path=/; SameSite=Lax" // omit Secure/HttpOnly so it works on localhost + visible for demo
) {
  headers["Set-Cookie"] = `${name}=${encodeURIComponent(value || "")}${attrs}`;
}

// --- flexible tool row ---
type ToolRow = {
  slug: string;
  title: string;
  summary?: string | null;
  why?: string | null;
  outcome?: string | null;
  content?: string | null;
  keywords?: string[] | string | null;
  patterns?: string[] | string | null;
  enabled: boolean;
};

function normalizeToolRow(row: any): ToolRow | null {
  if (!row) return null;

  const title = (coalesce<string>(row.title, row.tool_name, row.name, row.display_name) as string) || "";
  const slug = (coalesce<string>(row.slug, row.tool_slug, row.code, kebab(title)) as string) || "";
  if (!title || !slug) return null;

  const summary = coalesce<string>(row.summary, row.primary_use, row.description) ?? null;
  const why = coalesce<string>(row.why, row.value_prop, row.reason) ?? null;
  const outcome = coalesce<string>(row.outcome, row.result) ?? null;
  const content = (row.content != null ? String(row.content) : null) ?? null;

  const keywords = toList(row.keywords ?? row.tags ?? row.search_terms);
  const patterns = toList(row.patterns ?? row.regex ?? row.matchers);

  return {
    slug,
    title,
    summary,
    why,
    outcome,
    content,
    keywords: keywords.length ? keywords : null,
    patterns: patterns.length ? patterns : null,
    enabled: isEnabledRow(row),
  };
}

async function getToolRegistry(): Promise<ToolRow[]> {
  if (!sb) return [];
  const { data } = await sb.from("tool_docs").select("*");
  const out: ToolRow[] = [];
  for (const row of (data || []) as any[]) {
    const t = normalizeToolRow(row);
    if (t && t.enabled) out.push(t);
  }
  return out;
}

// 5-min in-memory cache
let TOOL_CACHE: { data: ToolRow[]; ts: number } | null = null;
async function getToolRegistryCached(): Promise<ToolRow[]> {
  const now = Date.now();
  if (TOOL_CACHE && now - TOOL_CACHE.ts < 5 * 60_000) return TOOL_CACHE.data;
  const data = await getToolRegistry();
  TOOL_CACHE = { data, ts: now };
  return data;
}

// --- match intent to tool (regex + keyword hits + lexical overlap) ---
function matchToolByIntent(userText: string, tools: ToolRow[]): ToolRow | null {
  const text = String(userText || "");
  const lower = text.toLowerCase();
  const hasWeeklyReport = /\bweekly\b.*\b(report|updates?)\b/i.test(text);

  let best: { tool: ToolRow; score: number } | null = null;
  for (const t of tools) {
    const title = t.title?.trim();
    if (!title) continue;

    const summary = t.summary?.trim() || "";
    const why = t.why?.trim() || "";
    const outcome = t.outcome?.trim() || "";
    const content = t.content?.trim() || "";

    const haystack = [title, summary, why, outcome, content].map(norm).join(" ");
    const user = norm(text);

    // patterns
    const rawPatterns = Array.isArray(t.patterns) ? t.patterns : toList(t.patterns);
    let patternHits = 0;
    for (const rx of rawPatterns) {
      try {
        if (new RegExp(rx, "i").test(text)) patternHits++;
      } catch {}
    }

    // keywords
    const kws = (Array.isArray(t.keywords) ? t.keywords : toList(t.keywords)).map((s) => s.toLowerCase());
    let kwHits = 0;
    for (const k of kws) if (k && lower.includes(k)) kwHits++;

    // lexical overlap
    const A = new Set(user.split(" ").filter(Boolean));
    const B = new Set(haystack.split(" ").filter(Boolean));
    let overlap = 0;
    for (const w of A) if (B.has(w)) overlap++;
    const lex = B.size ? overlap / Math.max(A.size, B.size) : 0;

    let score = patternHits * 2 + kwHits + lex * 3;
    if (hasWeeklyReport && /\bweekly\b.*\b(report|updates?)\b/.test(title.toLowerCase())) score += 3;

    if (!best || score > best.score) best = { tool: t, score };
  }
  if (!best || best.score < 1.0) return null;
  return best.tool;
}

function detectToolFromAssistant(assistantText: string, tools: ToolRow[]): ToolRow | null {
  if (!assistantText) return null;
  const m = assistantText.match(/^\s*Try\s*:\s*(.+)$/im);
  const candidate = m?.[1]?.trim();
  if (!candidate) return null;

  let best: { tool: ToolRow; score: number } | null = null;
  for (const t of tools) {
    const s = norm(t.title) === norm(candidate) ? 1 : tokenOverlap(t.title, candidate);
    if (!best || s > best.score) best = { tool: t, score: s };
  }
  if (best && best.score >= 0.7) return best.tool;
  return null;
}

// --- session memory helpers (optional; SERVICE_ROLE only) ---
async function getSessionMem(sessionId: string) {
  if (!sb || !sessionId) return { last_reco_slug: null as string | null, slots: {} as any };
  const { data } = await sb
    .from("session_memory")
    .select("last_reco_slug, slots")
    .eq("session_id", sessionId)
    .maybeSingle();
  return { last_reco_slug: (data as any)?.last_reco_slug ?? null, slots: (data as any)?.slots ?? {} };
}
async function setSessionMem(sessionId: string, mem: { last_reco_slug: string | null; slots?: any }) {
  if (!sb || !sessionId) return;
  void sb
    .from("session_memory")
    .upsert({
      session_id: sessionId,
      last_reco_slug: mem.last_reco_slug,
      slots: mem.slots ?? {},
      updated_at: new Date().toISOString(),
    })
    .then(() => {}, () => {});
}

// --- follow-up classifier & params ---
type FollowKind = "accept" | "reject" | "refine" | "askinfo" | "compare" | "none";
function isAffirmativeFollowUp(text: string): boolean {
  return /\b(yes|yep|yeah|do it|sounds good|let'?s (go|do it)|please|ok|okay|go ahead|run it|ship it)\b/i.test(text);
}
function isNegativeFollowUp(text: string): boolean {
  return /\b(no|nah|not now|pass|skip|don'?t|another way|different approach|prefer not)\b/i.test(text);
}
function isInfoFollowUp(text: string): boolean {
  // Covers:
  // - "what is it", "what does it do"
  // - "what does this tool do", "how does this tool work"
  // - "what does this do", "how does this work"
  // - "explain", "more detail", "tell me more", "why"
  return /\b(what\s+(is|does)\s+(it|this(\s+tool)?|that(\s+tool)?|this|that)\s*(do)?)\b/i.test(text)
      || /\b(how\s+(does|would)\s+(it|this(\s+tool)?|that(\s+tool)?|this|that)\s+work)\b/i.test(text)
      || /\b(explain|more\s+detail|tell\s+me\s+more|why)\b/i.test(text);
}

function isCompareFollowUp(text: string): boolean {
  return /\b(other (options|ways)|alternatives?|compare|vs\.?|versus)\b/i.test(text);
}
function parseRefineParams(text: string): PlanParams | null {
  const t = text.toLowerCase();
  const p: PlanParams = {};
  if (/\bbi[-\s]?weekly\b/.test(t)) p.cadence = "biweekly";
  else if (/\bmonthly\b/.test(t)) p.cadence = "monthly";
  else if (/\bdaily\b/.test(t)) p.cadence = "daily";
  else if (/\bweekly\b/.test(t)) p.cadence = "weekly";

  const dayMatch = t.match(/\b(mon|tue|wed|thu|fri|sat|sun)\w*\b/);
  if (dayMatch) p.due_day = dayMatch[0][0].toUpperCase() + dayMatch[0].slice(1);

  const timeMatch = t.match(/\b(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b/);
  if (timeMatch) p.due_time = timeMatch[0];

  if (/\bslack\b/.test(t)) p.channel = "slack";
  else if (/\bemail\b/.test(t)) p.channel = "email";
  else if (/\b(app|in[-\s]?app)\b/.test(t)) p.channel = "app";

  if (/\banonym(ous|ously)?\b/.test(t)) p.anonymous = true;

  if (/\bno (nudge|reminder)s?\b/.test(t)) p.reminders = 0;
  else if (/\bone (nudge|reminder)\b/.test(t)) p.reminders = 1;
  else if (/\b(two|2) (nudges|reminders)\b/.test(t)) p.reminders = 2;

  return Object.keys(p).length ? p : null;
}
function classifyFollowUp(text: string): FollowKind {
  if (isAffirmativeFollowUp(text)) return "accept";
  if (isNegativeFollowUp(text)) return "reject";
  if (isInfoFollowUp(text)) return "askinfo";
  if (isCompareFollowUp(text)) return "compare";
  if (parseRefineParams(text)) return "refine";
  return "none";
}
function mergeParams(a: PlanParams = {}, b: PlanParams = {}): PlanParams {
  return { ...a, ...b };
}

// ---------------------------
// Handler
// ---------------------------
export const handler: Handler = async (event) => {
  const t0 = Date.now();
  let tAfterRoute = 0,
    tAfterAgent = 0,
    tAfterPolicy = 0,
    tAfterTelemetry = 0;

  const POLICY_VERSION = "int-tools-hard-override-v1";
  const DEBUG_STAMP = new Date().toISOString();
  const qs = event.queryStringParameters || {};
  const debug = qs.debug === "1";
  const mode = qs.mode || ""; // mode=dry or mode=sim

  const headers: Record<string, string> = {
    "Content-Type": "text/plain; charset=utf-8",
    "Access-Control-Expose-Headers":
  "X-Route, X-RAG, X-RAG-Count, X-RAG-Mode, X-Embed-Model, X-Model, X-Reco, X-Reco-Slug, X-Duration-Total, X-Events, X-Events-Err, X-Events-Msg, X-Events-Stage, X-Policy-Version, X-Debug-Stamp, Server-Timing, X-Tools-Len, X-Route-Router, X-Router-Impl",
    "X-Policy-Version": POLICY_VERSION,
    "X-Debug-Stamp": DEBUG_STAMP,
  };
  headers["X-Events"] = "boot";
  headers["X-Events-Stage"] = "start";

  // allow GET only for debug/dry pings
  if (event.httpMethod !== "POST") {
    if (debug || mode === "dry") {
      headers["X-Events-Stage"] = "parsed";
      headers["X-Route"] = "noop";
      headers["X-Duration-Total"] = String(Date.now() - t0);
      headers["Server-Timing"] = `total;dur=${Date.now() - t0}`;
      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({ ok: true, note: "debug GET ok", policy: POLICY_VERSION }),
      };
    }
    headers["X-Events-Stage"] = "405";
    headers["Server-Timing"] = `total;dur=${Date.now() - t0}`;
    return { statusCode: 405, headers, body: "Method Not Allowed" };
  }

  let userText = "";
  let out:
    | {
        text: string;
        route: "qa" | "coach" | "tools" | string;
        reco?: boolean;
        meta?: { rag?: number; ragMode?: string | null; model?: string | null; recoSlug?: string | null };
      }
    | null = null;

  try {
    // ---- parse body ----
    const body = event.body ? JSON.parse(event.body) : {};
    const clientMessages = Array.isArray(body?.messages) ? body.messages : [];
    userText =
      body?.q ??
      [...clientMessages].reverse().find((m: any) => m?.role === "user" && typeof m?.content === "string")
        ?.content ??
      "";
    userText = String(userText).trim();
    const sessionId: string =
      body.sessionId ||
      (event.headers["x-session-id"] as string) ||
      (event.headers["X-Session-Id"] as string) ||
      "anon";
    headers["X-Events-Stage"] = "parsed";

    if (!userText) {
      headers["Server-Timing"] = `total;dur=${Date.now() - t0}`;
      return { statusCode: 400, headers, body: "Bad Request: missing user text" };
    }

    const mem = await getSessionMem(sessionId);

    // ---- DRY MODE ----
    if (mode === "dry") {
      headers["X-Route"] = "dry";
      headers["X-Duration-Total"] = String(Date.now() - t0);
      headers["Server-Timing"] = `total;dur=${Date.now() - t0}`;
      return { statusCode: 200, headers, body: `DRY OK — received: "${userText}"` };
    }

    // ---- SIM MODE (no OpenAI; policy only) ----
    if (mode === "sim") {
      const tools = await getToolRegistryCached();
      headers["X-Tools-Len"] = String(tools.length);
      const allow = buildAllowlist(tools.map((t) => ({ title: t.title })) as any);
      const chosen = matchToolByIntent(userText, tools);

      let bodyText = "";
      let route = "coach";
      let recoSlug: string | null = null;

      if (chosen) {
        route = "tools";
        bodyText = `${renderPlanForTool(chosen)}\n\n${formatTryLine(chosen)}`;
        recoSlug = chosen.slug || null;
        setCookie(headers, "last_reco_slug", recoSlug || "");
        await setSessionMem(sessionId, {
          last_reco_slug: recoSlug,
          slots: { proposed: { slug: chosen.slug, title: chosen.title, params: {} } },
        });
      } else {
        const rogue = [
          "Use Asana or ClickUp for this: https://example.com",
          "Alternatively, Microsoft Teams could work.",
          "Try: Random External Tool",
        ].join("\n");
        bodyText = removeExternalToolMentions(stripAllTryLines(rogue), allow);
      }

      headers["X-Route"] = route;
      headers["X-RAG"] = "false";
      headers["X-RAG-Count"] = "0";
      headers["X-Reco"] = String(!!recoSlug);
      if (recoSlug) headers["X-Reco-Slug"] = String(recoSlug);

      if (sb) {
        void sb
          .from("events")
          .insert({
            ts: new Date().toISOString(),
            q: userText.slice(0, 500),
            route,
            rag_count: 0,
            rag_mode: null,
            model: null,
            reco_slug: recoSlug,
            duration_ms: Date.now() - t0,
            ok: true,
          })
          .then(() => {}, () => {});
        headers["X-Events"] = "queued";
      } else headers["X-Events"] = "no-sb";

      headers["X-Events-Stage"] = "success";
      headers["X-Duration-Total"] = String(Date.now() - t0);
      headers["Server-Timing"] = `total;dur=${Date.now() - t0}`;
      return { statusCode: 200, headers, body: bodyText.trim() };
    }

    // ---- Deterministic follow-up layer ----
    const follow = classifyFollowUp(userText);

    // 1) from session memory
    let proposed =
      (mem.slots && (mem.slots as any).proposed) ||
      (mem.last_reco_slug ? { slug: mem.last_reco_slug } : null);

    // 2) from last assistant Try: line (requires messages[])
    if (!proposed) {
      const lastAssistantText =
        [...(clientMessages || [])].reverse().find((m: any) => m?.role === "assistant")?.content || "";
      if (lastAssistantText) {
        const toolsForDetect = await getToolRegistryCached();
        const det = detectToolFromAssistant(lastAssistantText, toolsForDetect);
        if (det) proposed = { slug: det.slug, title: det.title, params: {} };
      }
    }

    // 3) from cookie
    if (!proposed) {
      const ck = (event.headers["cookie"] as string) || (event.headers["Cookie"] as string) || "";
      const slugFromCookie = getCookie("last_reco_slug", ck);
      if (slugFromCookie) proposed = { slug: slugFromCookie };
    }

    if (proposed) {
      const tools = await getToolRegistryCached();
      headers["X-Tools-Len"] = String(tools.length);
      const chosen =
        tools.find((t) => t.slug === (proposed as any).slug) ||
        tools.find((t) => t.title === (proposed as any).title) ||
        null;

      if (follow === "accept" && chosen) {
        const params = ((proposed as any).params as PlanParams) || {};
        const finalText = `${renderPlanForTool(chosen, params)}\n\n${formatTryLine(chosen)}`;
        headers["X-Route"] = "tools";
        headers["X-Reco"] = "true";
        headers["X-Reco-Slug"] = String(chosen.slug || "");
        headers["X-RAG"] = "false";
        headers["X-RAG-Count"] = "0";
        setCookie(headers, "last_reco_slug", chosen.slug || "");
        await setSessionMem(sessionId, {
          last_reco_slug: chosen.slug || null,
          slots: { proposed: { slug: chosen.slug, title: chosen.title, params } },
        });
        headers["X-Events-Stage"] = "success";
        headers["X-Duration-Total"] = String(Date.now() - t0);
        headers["Server-Timing"] = `total;dur=${Date.now() - t0}`;
        return { statusCode: 200, headers, body: finalText };
      }

      if (follow === "reject") {
        await setSessionMem(sessionId, { last_reco_slug: null, slots: {} });
        // fall through to router
      }

      if (follow === "refine" && chosen) {
        const delta = parseRefineParams(userText) || {};
        const merged = mergeParams(((proposed as any).params as PlanParams) || {}, delta);
        const finalText = `${renderPlanForTool(chosen, merged)}\n\n${formatTryLine(chosen)}`;
        headers["X-Route"] = "tools";
        headers["X-Reco"] = "true";
        headers["X-Reco-Slug"] = String(chosen.slug || "");
        headers["X-RAG"] = "false";
        headers["X-RAG-Count"] = "0";
        setCookie(headers, "last_reco_slug", chosen.slug || "");
        await setSessionMem(sessionId, {
          last_reco_slug: chosen.slug || null,
          slots: { proposed: { slug: chosen.slug, title: chosen.title, params: merged } },
        });
        headers["X-Events-Stage"] = "success";
        headers["X-Duration-Total"] = String(Date.now() - t0);
        headers["Server-Timing"] = `total;dur=${Date.now() - t0}`;
        return { statusCode: 200, headers, body: finalText };
      }

      if (follow === "askinfo" && chosen) {
        const blurb = [
          `**What ${chosen.title} does**`,
          `- Purpose: ${chosen.summary || "collects quick updates with a simple template."}`,
          `- Why use it: ${chosen.why || "reduces nagging and increases cadence consistency."}`,
          `- Outcome: ${chosen.outcome || "you get a reliable weekly signal."}`,
          "",
          `If you want to proceed, say "yes" or refine (e.g., "biweekly via Slack on Fridays at 2pm").`,
        ].join("\n");
        headers["X-Route"] = "coach"; // informational; not a reco
        headers["X-Reco"] = "false";
        await setSessionMem(sessionId, {
          last_reco_slug: chosen.slug || null,
          slots: { proposed: { slug: chosen.slug, title: chosen.title, params: ((proposed as any).params as PlanParams) || {} } },
        });
        headers["X-Events-Stage"] = "success";
        headers["X-Duration-Total"] = String(Date.now() - t0);
        headers["Server-Timing"] = `total;dur=${Date.now() - t0}`;
        return { statusCode: 200, headers, body: blurb };
      }

      if (follow === "compare") {
        await setSessionMem(sessionId, { last_reco_slug: null, slots: {} });
        // fall through to router
      }
    }

    // ---- Router per turn (QA-first) ----
let decision: any = await pickRoute(userText, clientMessages as any);

// optional: let LLM scorer weigh in ONLY if not already QA with spans
const alreadyQA = decision?.route === "qa" && (decision?.ragMeta?.count ?? 0) > 0;

if (!alreadyQA) {
  try {
    const tools = await getToolRegistryCached();
    headers["X-Tools-Len"] = String(tools.length);
    const candidates = getCandidatesFromTools ? getCandidatesFromTools(tools as any, userText, 6) : [];
    const scored = await scoreRouteLLM({
      apiKey: process.env.OPENAI_API_KEY,
      model: process.env.OPENAI_CHAT_MODEL || "gpt-4o-mini",
      messages: clientMessages as any,
      userText,
      candidates,
      lastRecoSlug: (mem.slots as any)?.proposed?.slug || mem.last_reco_slug,
    });

    // Only accept the scorer if it’s confident AND not QA
    if (scored && scored.route !== "qa" && (scored.tool_intent_score ?? 0) >= 0.65) {
      decision = {
        route: scored.route,
        ragSpans: [],
        ragMeta: { count: 0, mode: null, model: null },
        best_tool_slug: scored.best_tool_slug,
        impl: (decision as any)?.impl || "qa-first-v2+llm",
      };
    }
  } catch {
    // ignore scorer failures; keep QA-first decision
  }
}

// expose router debug
headers["X-Route-Router"] = String(decision?.route || "");
if ((decision as any)?.impl) headers["X-Router-Impl"] = String((decision as any).impl);
    tAfterRoute = Date.now();

    // ---- Execute chosen path ----
let coachGround: { title?: string|null; url?: string|null; content: string; score?: number }[] = [];

if (decision.route === "qa") {
  out = await QaAgent.handle({ userText, messages: clientMessages, ragSpans: decision.ragSpans });
} else {
  // Fast retrieval to ground coach answers in internal principles
  const g = await retrieveSpans({ q: userText, topK: 3, minScore: 0.55 });
  coachGround = g.spans;
  out = await CoachAgent.handle({ userText, messages: clientMessages, grounding: coachGround });
}
tAfterAgent = Date.now();

    // ---- Policy: enforce internal tool if matched; else strip externals ----
    const tools = await getToolRegistryCached();
    headers["X-Tools-Len"] = String(tools.length);
    const allow = buildAllowlist(tools.map((t) => ({ title: t.title })) as any);

    let chosen: ToolRow | null = null;
    if (decision?.best_tool_slug) chosen = tools.find((t) => t.slug === decision.best_tool_slug) || null;
    if (!chosen) chosen = matchToolByIntent(userText, tools);
    if (!chosen) chosen = detectToolFromAssistant(out?.text ?? "", tools);

    let finalText: string;
let recoSlug: string | null = null;

// treat any routed QA with nonzero spans as QA; don't enforce tools on it
const isQA = (decision?.route === "qa") && ((decision?.ragMeta?.count ?? 0) > 0);

if (!isQA && chosen) {
  const params: PlanParams = ((mem.slots as any)?.proposed?.params as PlanParams) || {};
  finalText = `${renderPlanForTool(chosen, params)}\n\n${formatTryLine(chosen)}`.trim();
  recoSlug = chosen.slug || null;
  headers["X-Route"] = "tools";
  setCookie(headers, "last_reco_slug", recoSlug || "");
  await setSessionMem(sessionId, {
    last_reco_slug: chosen.slug || null,
    slots: { proposed: { slug: chosen.slug, title: chosen.title, params } },
  });
} else {
  // QA: keep the agent’s answer as-is; non-QA: still strip externals
  finalText = isQA ? (out?.text ?? "") : removeExternalToolMentions(stripAllTryLines(out?.text ?? ""), allow);
}
    tAfterPolicy = Date.now();

    const mergedMeta: any = { ...(out?.meta || {}), recoSlug };
if (decision?.route === "qa") {
  mergedMeta.rag     = decision?.ragMeta?.count ?? 0;
  mergedMeta.ragMode = decision?.ragMeta?.mode  ?? "raw";
  mergedMeta.model   = decision?.ragMeta?.model ?? mergedMeta.model ?? null;
}
out = {
  ...(out || { text: "", route: decision.route }),
  text: finalText,
  meta: mergedMeta,
  reco: !!recoSlug,
};

   // ---- headers ----
if (!headers["X-Route"]) headers["X-Route"] = String(out?.route ?? decision.route);

// router spans + (coach grounding only)
const ragFromRouter = Number(decision?.ragMeta?.count ?? 0);
const ragFromAgent  = decision?.route === "qa" ? 0 : Number((out as any)?.meta?.rag ?? 0);
const totalRagCount = ragFromRouter + ragFromAgent;

headers["X-RAG"]       = String(totalRagCount > 0);
headers["X-RAG-Count"] = String(totalRagCount);

// Prefer router’s mode/model; fall back to agent’s (coach grounding)
const ragMode    = decision?.ragMeta?.mode  ?? (out as any)?.meta?.ragMode ?? null;
const embedModel = decision?.ragMeta?.model ?? (out as any)?.meta?.model   ?? null;
if (ragMode)    headers["X-RAG-Mode"]    = String(ragMode);
if (embedModel) headers["X-Embed-Model"] = String(embedModel);

headers["X-Reco"] = String(!!out?.reco);
if (out?.meta?.recoSlug) headers["X-Reco-Slug"] = String(out.meta.recoSlug);

// (optional for quick debugging)
headers["X-Coach-RAG-Count"] = String(ragFromAgent);


    // ---- telemetry (fire-and-forget) ----
    const duration = Date.now() - t0;
    headers["X-Duration-Total"] = String(duration);
    if (sb) {
      void sb
        .from("events")
        .insert({
          ts: new Date().toISOString(),
          q: userText.slice(0, 500),
          route: headers["X-Route"] || out?.route || decision.route,
          rag_count: decision?.ragMeta?.count ?? 0,
          rag_mode: decision?.ragMeta?.mode ?? null,
          model: decision?.ragMeta?.model ?? null,
          reco_slug: out?.meta?.recoSlug ?? null,
          duration_ms: duration,
          ok: true,
        })
        .then(() => {}, () => {});
      headers["X-Events"] = "queued";
    } else {
      headers["X-Events"] = "no-sb";
    }
    headers["X-Events-Stage"] = "success";

    // ---- server-timing ----
    tAfterTelemetry = Date.now();
    headers["Server-Timing"] = [
      `route;dur=${tAfterRoute - t0}`,
      `agent;dur=${tAfterAgent - tAfterRoute}`,
      `policy;dur=${tAfterPolicy - tAfterAgent}`,
      `telemetry;dur=${tAfterTelemetry - tAfterPolicy}`,
      `total;dur=${Date.now() - t0}`,
    ].join(", ");

    return { statusCode: 200, headers, body: out?.text || "" };
  } catch (err: any) {
    const duration = Date.now() - t0;
    headers["X-Duration-Total"] = String(duration);

    if (sb) {
      void sb
        .from("events")
        .insert({
          ts: new Date().toISOString(),
          q: userText.slice(0, 500),
          route: out?.route ?? null,
          rag_count: out?.meta?.rag ?? 0,
          rag_mode: out?.meta?.ragMode ?? null,
          model: out?.meta?.model ?? null,
          reco_slug: out?.meta?.recoSlug ?? null,
          duration_ms: duration,
          ok: false,
          err: String(err?.stack || err?.message || err || "unknown"),
        })
        .then(() => {}, () => {});
      headers["X-Events"] = "queued";
    } else {
      headers["X-Events"] = "no-sb";
    }

    headers["X-Events-Stage"] = "error";
    headers["Server-Timing"] = [
      `route;dur=${Math.max(0, tAfterRoute - t0)}`,
      `agent;dur=${tAfterAgent && tAfterRoute ? tAfterAgent - tAfterRoute : 0}`,
      `policy;dur=${tAfterPolicy && tAfterAgent ? tAfterPolicy - tAfterAgent : 0}`,
      `telemetry;dur=${Date.now() - (tAfterPolicy || t0)}`,
      `total;dur=${Date.now() - t0}`,
    ].join(", ");

    if (debug) {
      headers["Content-Type"] = "application/json; charset=utf-8";
      const body = JSON.stringify(
        { ok: false, error: String(err?.message || err), stack: String(err?.stack || "") },
        null,
        2
      );
      return { statusCode: 200, headers, body };
    }

    return { statusCode: 500, headers, body: "Internal Server Error" };
  }
};
