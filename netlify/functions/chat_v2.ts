// netlify/functions/chat_v2.ts
import type { Handler } from "@netlify/functions";
import { createClient } from "@supabase/supabase-js";

import { route as pickRoute } from "./lib/agents/router";
import { QaAgent } from "./lib/agents/qa";
import { CoachAgent } from "./lib/agents/coach";
import { ToolsAgent } from "./lib/agents/tools";

import {
  buildAllowlist,
  stripAllTryLines,
  removeExternalToolMentions,
} from "./lib/sanitize";

import {
  isAffirmativeFollowUp,
  getCandidatesFromTools,
  scoreRouteLLM,
} from "./lib/agents/router_v2";

// ---------------------------
// Supabase (optional; telemetry & registry)
// ---------------------------
const sb =
  process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY
    ? createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!)
    : null;

// ---------------------------
// Helpers (policy-safe)
// ---------------------------

/** Canonical Try line */
function formatTryLine(t: { title: string }) {
  return `Try: ${t.title}`;
}

/** House plan text (safe, internal) */
function renderPlanForTool(tool: { title: string; outcome?: string | null }) {
  const outcome = tool.outcome || "reliable weekly signal without manual chasing";
  return [
    `Here’s the fastest path using **${tool.title}**:`,
    "",
    "- **Set the rhythm:** Pick one submission deadline (e.g., Fridays 3pm).",
    "- **Use the built-in template:** Wins, blockers, next week.",
    "- **Auto-nudge once:** A single reminder before the deadline.",
    "- **Model the habit:** Post your own update first.",
    "- **Close the loop:** Share highlights weekly to show value.",
    "",
    `Result: ${outcome}.`,
  ].join("\n");
}

/** normalize for fuzzy checks */
function norm(s: string) {
  return String(s || "")
    .toLowerCase()
    .replace(/\btool\b/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/** very light token overlap score (0..1) */
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
    // pg text[] string form -> {a,b}
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

/** Normalize one raw DB row into the shape the app expects (schema-agnostic). */
function normalizeToolRow(row: any): ToolRow | null {
  if (!row) return null;

  const title =
    (coalesce<string>(row.title, row.tool_name, row.name, row.display_name) as string) || "";
  const slug =
    (coalesce<string>(row.slug, row.tool_slug, row.code, kebab(title)) as string) || "";
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

/** Fetch tools using a broad select and normalize to the contract this app needs. */
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

/** 5 min in-memory cache for tool registry */
let TOOL_CACHE: { data: ToolRow[]; ts: number } | null = null;
async function getToolRegistryCached(): Promise<ToolRow[]> {
  const now = Date.now();
  if (TOOL_CACHE && now - TOOL_CACHE.ts < 5 * 60_000) return TOOL_CACHE.data;
  const data = await getToolRegistry();
  TOOL_CACHE = { data, ts: now };
  return data;
}

/**
 * Smart intent match:
 * - patterns (regex) → strong signal
 * - keywords overlap
 * - lexical overlap with title/summary/primary_use/content (handles legacy schemas)
 * - tiny hand-tuned boost for common phrases like "weekly report"
 */
function matchToolByIntent(userText: string, tools: ToolRow[]): ToolRow | null {
  const text = String(userText || "");
  const lower = text.toLowerCase();

  // quick phrase heuristics
  const hasWeeklyReport = /\bweekly\b.*\b(report|updates?)\b/i.test(text);

  let best: { tool: ToolRow; score: number } | null = null;

  for (const t of tools) {
    // title required
    const title = t.title?.trim();
    if (!title) continue;

    const summary = t.summary?.trim() || "";
    const why = t.why?.trim() || "";
    const outcome = t.outcome?.trim() || "";
    const content = t.content?.trim() || "";

    const haystack = [title, summary, why, outcome, content].map(norm).join(" ");
    const user = norm(text);

    // patterns (regex strings)
    const rawPatterns = Array.isArray(t.patterns) ? t.patterns : toList(t.patterns);
    let patternHits = 0;
    for (const rx of rawPatterns) {
      try {
        if (new RegExp(rx, "i").test(text)) patternHits++;
      } catch {}
    }

    // keywords (strings/array)
    const kws = (Array.isArray(t.keywords) ? t.keywords : toList(t.keywords)).map((s) =>
      s.toLowerCase()
    );
    let kwHits = 0;
    for (const k of kws) if (k && lower.includes(k)) kwHits++;

    // lexical overlap via token intersection (Jaccard-like)
    const A = new Set(user.split(" ").filter(Boolean));
    const B = new Set(haystack.split(" ").filter(Boolean));
    let overlap = 0;
    for (const w of A) if (B.has(w)) overlap++;
    const lex = B.size ? overlap / Math.max(A.size, B.size) : 0;

    // score
    let score = patternHits * 2 + kwHits + lex * 3;

    // small hand-tuned boost for "weekly report"-ish prompts when title mentions it
    if (hasWeeklyReport && /\bweekly\b.*\b(report|updates?)\b/.test(title.toLowerCase())) score += 3;

    if (!best || score > best.score) best = { tool: t, score };
  }

  // require some signal but keep the bar low so legacy rows match
  if (!best || best.score < 1.0) return null;
  return best.tool;
}

/** Parse "Try: <candidate>" from assistant text and map to known tool via fuzzy title match */
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

// ---- session memory helpers ----
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
    .then(
      () => {},
      () => {}
    );
}

// ---------------------------
// Agents registry
// ---------------------------
const agents = { qa: QaAgent, coach: CoachAgent, tools: ToolsAgent } as const;

// ---------------------------
// Handler
// ---------------------------
export const handler: Handler = async (event) => {
  const t0 = Date.now();
  let tAfterRoute = 0,
    tAfterAgent = 0,
    tAfterPolicy = 0,
    tAfterTelemetry = 0;

  // debug flags
  const POLICY_VERSION = "int-tools-hard-override-v1";
  const DEBUG_STAMP = new Date().toISOString();
  const qs = event.queryStringParameters || {};
  const debug = qs.debug === "1";
  const mode = qs.mode || ""; // mode=dry or mode=sim

  // base headers
  const headers: Record<string, string> = {
    "Content-Type": "text/plain; charset=utf-8",
    "Access-Control-Expose-Headers":
      "X-Route, X-RAG, X-RAG-Count, X-RAG-Mode, X-Embed-Model, X-Model, X-Reco, X-Reco-Slug, X-Duration-Total, X-Events, X-Events-Err, X-Events-Msg, X-Events-Stage, X-Policy-Version, X-Debug-Stamp, Server-Timing, X-Tools-Len",
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
        route: keyof typeof agents | string;
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
    const sessionId: string = body.sessionId || (event.headers["x-session-id"] as string) || "anon";
    headers["X-Events-Stage"] = "parsed";

    if (!userText) {
      headers["Server-Timing"] = `total;dur=${Date.now() - t0}`;
      return { statusCode: 400, headers, body: "Bad Request: missing user text" };
    }

    // load session memory
    const mem = await getSessionMem(sessionId);

    // ---- DRY MODE: bypass agents to isolate infra/env ----
    if (mode === "dry") {
      headers["X-Route"] = "dry";
      headers["X-Duration-Total"] = String(Date.now() - t0);
      headers["Server-Timing"] = `total;dur=${Date.now() - t0}`;
      return {
        statusCode: 200,
        headers,
        body: `DRY OK — received: "${userText}"`,
      };
    }

    // ---- SIM MODE: run policy/tool selection without calling agents/OpenAI ----
    if (mode === "sim") {
      let tools = await getToolRegistryCached();
      headers["X-Tools-Len"] = String(tools.length);

      // if the registry is empty, we won't fabricate a fake tool; we instead let policy clean guidance
      const allow = buildAllowlist(tools);
      const chosen = matchToolByIntent(userText, tools);

      let bodyText: string;
      let route = "coach";
      let recoSlug: string | null = null;

      if (chosen) {
        route = "tools";
        bodyText = `${renderPlanForTool(chosen)}\n\n${formatTryLine(chosen)}`;
        recoSlug = chosen.slug || null;
        await setSessionMem(sessionId, { last_reco_slug: recoSlug, slots: mem.slots });
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

      // fire-and-forget telemetry
      if (sb) {
        const row = {
          ts: new Date().toISOString(),
          q: userText.slice(0, 500),
          route,
          rag_count: 0,
          rag_mode: null,
          model: null,
          reco_slug: recoSlug,
          duration_ms: Date.now() - t0,
          ok: true,
        };
        void sb.from("events").insert(row).then(
          () => {},
          () => {}
        );
        headers["X-Events"] = "queued";
      } else {
        headers["X-Events"] = "no-sb";
      }

      headers["X-Events-Stage"] = "success";
      headers["X-Duration-Total"] = String(Date.now() - t0);
      headers["Server-Timing"] = `total;dur=${Date.now() - t0}`;
      return { statusCode: 200, headers, body: bodyText.trim() };
    }

    // ---- Affirmative follow-up maps to last recommendation if present ----
    if (isAffirmativeFollowUp(userText) && mem.last_reco_slug) {
      const tools = await getToolRegistryCached();
      headers["X-Tools-Len"] = String(tools.length);
      const chosen = tools.find((t) => t.slug === mem.last_reco_slug) || null;

      if (chosen) {
        const finalText = `${renderPlanForTool(chosen)}\n\n${formatTryLine(chosen)}`;
        headers["X-Route"] = "tools";
        headers["X-Reco"] = "true";
        headers["X-Reco-Slug"] = String(chosen.slug || "");
        headers["X-RAG"] = "false";
        headers["X-RAG-Count"] = "0";

        // queue telemetry
        if (sb) {
          const row = {
            ts: new Date().toISOString(),
            q: userText.slice(0, 500),
            route: "tools",
            rag_count: 0,
            rag_mode: null,
            model: null,
            reco_slug: chosen.slug || null,
            duration_ms: Date.now() - t0,
            ok: true,
          };
          void sb.from("events").insert(row).then(
            () => {},
            () => {}
          );
          headers["X-Events"] = "queued";
        } else headers["X-Events"] = "no-sb";

        headers["X-Events-Stage"] = "success";
        headers["X-Duration-Total"] = String(Date.now() - t0);
        headers["Server-Timing"] = `total;dur=${Date.now() - t0}`;
        await setSessionMem(sessionId, { last_reco_slug: mem.last_reco_slug, slots: mem.slots });
        return { statusCode: 200, headers, body: finalText.trim() };
      }
    }

    // ---- route & run (Router v2 scoring optional, fallback to v1) ----
    let decision: any = null;
    try {
      const tools = await getToolRegistryCached();
      headers["X-Tools-Len"] = String(tools.length);
      const candidates = getCandidatesFromTools(
        // map to what router_v2 expects
        tools.map((t) => ({ ...t, enabled: true })) as any,
        userText,
        6
      );
      const scored = await scoreRouteLLM({
        apiKey: process.env.OPENAI_API_KEY,
        model: process.env.OPENAI_CHAT_MODEL || "gpt-4o-mini",
        messages: clientMessages as any,
        userText,
        candidates,
        lastRecoSlug: mem.last_reco_slug,
      });
      if (scored && typeof scored.tool_intent_score === "number" && scored.tool_intent_score < 0.45) {
        // ignore low-confidence tool picks
      } else if (scored) {
        decision = {
          route: scored.route,
          ragSpans: [],
          ragMeta: { count: 0, mode: null, model: null },
          best_tool_slug: scored.best_tool_slug,
        };
      }
    } catch {}
    if (!decision) decision = await pickRoute(userText, clientMessages as any);
    tAfterRoute = Date.now();

    if (decision.route === "qa") {
      out = await QaAgent.handle({ userText, messages: clientMessages, ragSpans: decision.ragSpans });
    } else if (decision.route === "tools") {
      out = await ToolsAgent.handle({ userText, messages: clientMessages });
    } else {
      out = await CoachAgent.handle({ userText, messages: clientMessages });
    }
    tAfterAgent = Date.now();

    // ---- tool enforcement (hard override, internal only) ----
    const tools = await getToolRegistryCached();
    headers["X-Tools-Len"] = String(tools.length);
    const allow = buildAllowlist(
      tools.map((t) => ({ title: t.title })) as any // buildAllowlist expects titles
    );

    // Prefer LLM-picked slug if present; else intent; else Try-line in assistant text
    let chosen: ToolRow | null = null;
    if (decision?.best_tool_slug) {
      chosen = tools.find((t) => t.slug === decision.best_tool_slug) || null;
    }
    if (!chosen) chosen = matchToolByIntent(userText, tools);
    if (!chosen) chosen = detectToolFromAssistant(out?.text ?? "", tools);

    let finalText: string;
    let recoSlug: string | null = null;

    if (chosen) {
      finalText = `${renderPlanForTool(chosen)}\n\n${formatTryLine(chosen)}`.trim();
      recoSlug = chosen.slug || null;
      // If we enforced a house tool, advertise tools route in headers
      headers["X-Route"] = "tools";
    } else {
      finalText = removeExternalToolMentions(stripAllTryLines(out?.text ?? ""), allow);
    }
    tAfterPolicy = Date.now();

    out = {
      ...(out || { text: "", route: decision.route }),
      text: finalText,
      meta: {
        ...(out?.meta || {}),
        rag: decision?.ragMeta?.count ?? 0,
        ragMode: decision?.ragMeta?.mode ?? null,
        model: decision?.ragMeta?.model ?? null,
        recoSlug,
      },
      reco: !!recoSlug,
    };

    // ---- update session memory if we actually recommended ----
    if (out.reco && out.meta?.recoSlug) {
      await setSessionMem(sessionId, { last_reco_slug: out.meta.recoSlug, slots: (await getSessionMem(sessionId)).slots });
    }

    // ---- headers ----
    if (!headers["X-Route"]) headers["X-Route"] = String(out?.route ?? decision.route);
    headers["X-RAG"] = String(!!(decision?.ragMeta?.count ?? 0));
    headers["X-RAG-Count"] = String(decision?.ragMeta?.count ?? 0);
    if (decision?.ragMeta?.mode) headers["X-RAG-Mode"] = String(decision.ragMeta.mode);
    if (decision?.ragMeta?.model) headers["X-Embed-Model"] = String(decision.ragMeta.model);
    headers["X-Reco"] = String(!!out?.reco);
    if (out?.meta?.recoSlug) headers["X-Reco-Slug"] = String(out.meta.recoSlug);

    // ---- telemetry (fire-and-forget) ----
    const duration = Date.now() - t0;
    headers["X-Duration-Total"] = String(duration);
    if (sb) {
      const row = {
        ts: new Date().toISOString(),
        q: userText.slice(0, 500),
        route: headers["X-Route"] || out?.route || decision.route,
        rag_count: decision?.ragMeta?.count ?? 0,
        rag_mode: decision?.ragMeta?.mode ?? null,
        model: decision?.ragMeta?.model ?? null,
        reco_slug: out?.meta?.recoSlug ?? null,
        duration_ms: duration,
        ok: true,
      };
      void sb.from("events").insert(row).then(
        () => {},
        () => {}
      );
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

    // fire-and-forget failure telemetry
    if (sb) {
      const row = {
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
      };
      void sb.from("events").insert(row).then(
        () => {},
        () => {}
      );
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
