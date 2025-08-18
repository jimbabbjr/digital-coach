// netlify/functions/chat_v2.ts
import type { Handler } from "@netlify/functions";
import { createClient } from "@supabase/supabase-js";

import { route as pickRoute } from "./lib/agents/router";
import { QaAgent } from "./lib/agents/qa";
import { CoachAgent } from "./lib/agents/coach";
import { ToolsAgent } from "./lib/agents/tools";

import type { ToolDoc } from "./lib/tools";
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

/** Fetch enabled tools (minimal columns) */
async function getToolRegistry(): Promise<ToolDoc[]> {
  if (!sb) return [];
  const { data } = await sb
    .from("tool_docs")
    .select("slug,title,summary,why,outcome,keywords,patterns,enabled")
    .eq("enabled", true);
  return (data || []) as unknown as ToolDoc[];
}

/** 5 min in-memory cache for tool registry */
let TOOL_CACHE: { data: ToolDoc[]; ts: number } | null = null;
async function getToolRegistryCached(): Promise<ToolDoc[]> {
  const now = Date.now();
  if (TOOL_CACHE && now - TOOL_CACHE.ts < 5 * 60_000) return TOOL_CACHE.data;
  const data = await getToolRegistry();
  TOOL_CACHE = { data, ts: now };
  return data;
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

/** regex+keyword scoring; returns best enabled tool or null */
function matchToolByIntent(userText: string, tools: ToolDoc[]): ToolDoc | null {
  const text = String(userText || "");
  let best: { tool: ToolDoc; score: number } | null = null;

  for (const t of tools) {
    if (!(t as any)?.enabled || !t?.title) continue;

    // patterns: csv/array of regex strings
    let patternHits = 0;
    const rawPatterns =
      Array.isArray((t as any).patterns)
        ? (t as any).patterns
        : String((t as any).patterns || "")
            .split(",")
            .map((s) => s.trim())
            .filter(Boolean);

    for (const rx of rawPatterns) {
      try {
        if (new RegExp(rx, "i").test(text)) patternHits++;
      } catch {}
    }

    // keywords: csv/array
    const kws =
      Array.isArray((t as any).keywords)
        ? (t as any).keywords
        : String((t as any).keywords || "")
            .split(",")
            .map((s) => s.trim().toLowerCase())
            .filter(Boolean);

    let kwHits = 0;
    const lower = text.toLowerCase();
    for (const k of kws) if (k && lower.includes(k)) kwHits++;

    const score = patternHits * 2 + kwHits;
    if (!best || score > best.score) best = { tool: t, score };
  }

  if (!best || best.score <= 0) return null;
  return best.tool;
}

/** Parse "Try: <candidate>" from assistant text and map to known tool via fuzzy title match */
function detectToolFromAssistant(assistantText: string, tools: ToolDoc[]): ToolDoc | null {
  if (!assistantText) return null;
  const m = assistantText.match(/^\s*Try\s*:\s*(.+)$/im);
  const candidate = m?.[1]?.trim();
  if (!candidate) return null;

  // exact or fuzzy title match (>= 0.7 overlap)
  let best: { tool: ToolDoc; score: number } | null = null;
  for (const t of tools) {
    const s = norm((t as any).title) === norm(candidate) ? 1 : tokenOverlap((t as any).title, candidate);
    if (!best || s > best.score) best = { tool: t, score: s };
  }
  if (best && best.score >= 0.7) return best.tool;
  return null;
}

/** Canonical Try line */
function formatTryLine(t: ToolDoc) { return `Try: ${(t as any).title}`; }

/** House plan text (safe, internal) */
function renderPlanForTool(tool: ToolDoc): string {
  const outcome = (tool as any).outcome || "reliable weekly signal without manual chasing";
  return [
    `Here’s the fastest path using **${(tool as any).title}**:`,
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
    .then(() => {}, () => {});
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
  let tAfterRoute = 0, tAfterAgent = 0, tAfterPolicy = 0, tAfterTelemetry = 0;

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
      "X-Route, X-RAG, X-RAG-Count, X-RAG-Mode, X-Embed-Model, X-Model, X-Reco, X-Reco-Slug, X-Duration-Total, X-Events, X-Events-Err, X-Events-Msg, X-Events-Stage, X-Policy-Version, X-Debug-Stamp, Server-Timing",
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
      if (!tools.length) {
        tools = [
          {
            slug: "weekly-report",
            title: "Weekly Report",
            keywords: "weekly,report,updates",
            patterns: "weekly\\s+report",
            enabled: true,
          } as any,
        ];
      }

      const allow = buildAllowlist(tools);
      const chosen = matchToolByIntent(userText, tools);

      let bodyText: string;
      let route = "coach";
      let recoSlug: string | null = null;

      if (chosen) {
        route = "tools";
        bodyText = `${renderPlanForTool(chosen)}\n\n${formatTryLine(chosen)}`;
        recoSlug = (chosen as any).slug || null;
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
      if (recoSlug) headers["X-Reco-Slug"] = recoSlug;

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
        void sb.from("events").insert(row).then(() => {}, () => {});
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
      const chosen = tools.find((t) => (t as any).slug === mem.last_reco_slug) || null;

      if (chosen) {
        const finalText = `${renderPlanForTool(chosen)}\n\n${formatTryLine(chosen)}`;
        headers["X-Route"] = "tools";
        headers["X-Reco"] = "true";
        headers["X-Reco-Slug"] = String((chosen as any).slug || "");
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
            reco_slug: (chosen as any).slug || null,
            duration_ms: Date.now() - t0,
            ok: true,
          };
          void sb.from("events").insert(row).then(() => {}, () => {});
          headers["X-Events"] = "queued";
        } else headers["X-Events"] = "no-sb";

        headers["X-Events-Stage"] = "success";
        headers["X-Duration-Total"] = String(Date.now() - t0);
        headers["Server-Timing"] = `total;dur=${Date.now() - t0}`;
        // keep same memory slug
        await setSessionMem(sessionId, { last_reco_slug: mem.last_reco_slug, slots: mem.slots });
        return { statusCode: 200, headers, body: finalText.trim() };
      }
    }

    // ---- route & run (Router v2 scoring optional, fallback to v1) ----
    let decision: any = null;
    try {
      const tools = await getToolRegistryCached();
      const candidates = getCandidatesFromTools(tools, userText, 6);
      const scored = await scoreRouteLLM({
        apiKey: process.env.OPENAI_API_KEY,
        model: process.env.OPENAI_CHAT_MODEL || "gpt-4o-mini",
        messages: clientMessages as any,
        userText,
        candidates,
        lastRecoSlug: mem.last_reco_slug,
      });
      if (scored) {
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
    const allow = buildAllowlist(tools || []);

    // Prefer LLM-picked slug if present; else intent; else Try-line in assistant text
    let chosen: ToolDoc | null = null;
    if (decision?.best_tool_slug) {
      chosen = tools.find((t) => (t as any).slug === decision.best_tool_slug) || null;
    }
    if (!chosen) chosen = matchToolByIntent(userText, tools);
    if (!chosen) chosen = detectToolFromAssistant(out?.text ?? "", tools);

    let finalText: string;
    let recoSlug: string | null = null;

    if (chosen) {
      finalText = `${renderPlanForTool(chosen)}\n\n${formatTryLine(chosen)}`.trim();
      recoSlug = (chosen as any).slug || null;
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
    headers["X-Route"] = String(out?.route ?? decision.route);
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
        route: out?.route ?? decision.route,
        rag_count: decision?.ragMeta?.count ?? 0,
        rag_mode: decision?.ragMeta?.mode ?? null,
        model: decision?.ragMeta?.model ?? null,
        reco_slug: out?.meta?.recoSlug ?? null,
        duration_ms: duration,
        ok: true,
      };
      void sb.from("events").insert(row).then(() => {}, () => {});
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
      void sb.from("events").insert(row).then(() => {}, () => {});
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
