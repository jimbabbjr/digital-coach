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

// ---- helpers (policy-safe) ----

// Supabase client (optional telemetry + tool registry)
const sb =
  process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY
    ? createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!)
    : null;

/** Fetch enabled tools (minimal columns) */
async function getToolRegistry(): Promise<ToolDoc[]> {
  if (!sb) return [];
  const { data, error } = await sb
    .from("tool_docs")
    .select("slug,title,summary,why,outcome,keywords,patterns,enabled")
    .eq("enabled", true);
  if (error || !data) return [];
  return data as unknown as ToolDoc[];
}

/** normalize for fuzzy checks (mirrors your sanitize.ts approach) */
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

/** Pass-1 regex match, Pass-2 keyword overlap; returns best enabled tool or null */
function matchToolByIntent(userText: string, tools: ToolDoc[]): ToolDoc | null {
  const text = String(userText || "");
  let best: { tool: ToolDoc; score: number } | null = null;

  for (const t of tools) {
    if (!t?.title) continue;

    // patterns: csv/array of regex strings
    let patternHits = 0;
    const rawPatterns =
      Array.isArray((t as any).patterns)
        ? (t as any).patterns
        : String((t as any).patterns || "")
            .split(",")
            .map(s => s.trim())
            .filter(Boolean);

    for (const rx of rawPatterns) {
      try {
        if (new RegExp(rx, "i").test(text)) patternHits++;
      } catch {
        /* ignore bad regex */
      }
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

  // require at least one signal
  if (!best || best.score <= 0) return null;
  return best.tool;
}

/** Parse "Try: <candidate>" from assistant text and map to known tool via fuzzy title match */
function detectToolFromAssistant(assistantText: string, tools: ToolDoc[]): ToolDoc | null {
  if (!assistantText) return null;

  // look for a Try line
  const m = assistantText.match(/^\s*Try\s*:\s*(.+)$/im);
  const candidate = m?.[1]?.trim();
  if (!candidate) return null;

  // exact or fuzzy title match (>= 0.7 overlap)
  let best: { tool: ToolDoc; score: number } | null = null;
  for (const t of tools) {
    const s =
      norm(t.title) === norm(candidate)
        ? 1
        : tokenOverlap(t.title, candidate);
    if (!best || s > best.score) best = { tool: t, score: s };
  }
  if (best && best.score >= 0.7) return best.tool;
  return null;
}

/** Canonical Try line */
function formatTryLine(t: ToolDoc) {
  return `Try: ${t.title}`;
}

/** House plan text (safe, internal) */
function renderPlanForTool(tool: ToolDoc): string {
  const outcome = (tool as any).outcome || "reliable weekly signal without manual chasing";
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

// ---- agents registry ----
const agents = { qa: QaAgent, coach: CoachAgent, tools: ToolsAgent } as const;

export const handler: Handler = async (event) => {
  const t0 = Date.now();

  // debug flags
  const POLICY_VERSION = "int-tools-hard-override-v1";
  const DEBUG_STAMP = new Date().toISOString();
  const qs = event.queryStringParameters || {};
  const debug = qs.debug === "1";
  const mode = qs.mode || ""; // mode=dry to bypass agents

  // base headers
  const headers: Record<string, string> = {
    "Content-Type": "text/plain; charset=utf-8",
    "Access-Control-Expose-Headers":
      "X-Route, X-RAG, X-RAG-Count, X-RAG-Mode, X-Embed-Model, X-Model, X-Reco, X-Reco-Slug, X-Duration-Total, X-Events, X-Events-Err, X-Events-Msg, X-Events-Stage, X-Policy-Version, X-Debug-Stamp",
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
      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({ ok: true, note: "debug GET ok", policy: POLICY_VERSION }),
      };
    }
    headers["X-Events-Stage"] = "405";
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
    headers["X-Events-Stage"] = "parsed";

    if (!userText) {
      return { statusCode: 400, headers, body: "Bad Request: missing user text" };
    }

    // ---- DRY MODE: bypass agents to isolate infra/env ----
    if (mode === "dry") {
      headers["X-Route"] = "dry";
      headers["X-Duration-Total"] = String(Date.now() - t0);
      return {
        statusCode: 200,
        headers,
        body: `DRY OK — received: "${userText}"`,
      };
    }

    // ---- SIM MODE: run policy/tool selection without calling agents/OpenAI ----
if (mode === "sim") {
  // registry + allowlist (works if Supabase is configured)
  let tools = await getToolRegistry();

  // fallback for local/dev without Supabase data
  if (!tools.length) {
    tools = [
      {
        slug: "weekly-report",
        title: "Weekly Report",
        keywords: "weekly,report,updates",
        patterns: "weekly\\s+report",
        enabled: true
      } as any
    ];
  }

  const allow = buildAllowlist(tools);

  // Try to pick a tool from the user's text; else craft a body that exercises sanitizers
  const chosen = matchToolByIntent(userText, tools);

  let bodyText: string;
  let route = "coach";
  let recoSlug: string | null = null;

  if (chosen) {
    route = "tools";
    bodyText = `${renderPlanForTool(chosen)}\n\n${formatTryLine(chosen)}`;
    recoSlug = (chosen as any).slug || null;
  } else {
    // include external brands + a rogue Try line to verify policy stripping
    const rogue = [
      "Use Asana or ClickUp for this: https://example.com",
      "Alternatively, Microsoft Teams could work.",
      "Try: Random External Tool"
    ].join("\n");

    // sanitize like the real non-tools path
    bodyText = removeExternalToolMentions(stripAllTryLines(rogue), allow);
  }

  // headers like normal
  headers["X-Route"] = route;
  headers["X-RAG"] = "false";
  headers["X-RAG-Count"] = "0";
  headers["X-Reco"] = String(!!recoSlug);
  if (recoSlug) headers["X-Reco-Slug"] = recoSlug;
  headers["X-Duration-Total"] = String(Date.now() - t0);
  headers["X-Events-Stage"] = "success";

  // telemetry (optional)
  try {
    if (!sb) {
      headers["X-Events"] = "no-sb";
    } else {
      const { error } = await sb.from("events").insert({
        ts: new Date().toISOString(),
        q: userText.slice(0, 500),
        route,
        rag_count: 0,
        rag_mode: null,
        model: null,
        reco_slug: recoSlug,
        duration_ms: Date.now() - t0,
        ok: true
      });
      headers["X-Events"] = error ? "err" : "ok";
      if (error) headers["X-Events-Err"] = String((error as any).code || "insert_error");
    }
  } catch {
    headers["X-Events"] = "threw";
  }

  return { statusCode: 200, headers, body: bodyText.trim() };
}

    // ---- route & run ----
    const decision = await pickRoute(userText, clientMessages as any);

    if (decision.route === "qa") {
      out = await QaAgent.handle({ userText, messages: clientMessages, ragSpans: decision.ragSpans });
    } else if (decision.route === "tools") {
      out = await ToolsAgent.handle({ userText, messages: clientMessages });
    } else {
      out = await CoachAgent.handle({ userText, messages: clientMessages });
    }

    // ---- tool enforcement (hard override, internal only) ----
    const tools = await getToolRegistry();
    const allow = buildAllowlist(tools || []);
    // 1) try to pick by user intent; 2) fallback to assistant "Try:" if it matches a house tool
    const chosen =
      matchToolByIntent(userText, tools) ||
      detectToolFromAssistant(out?.text ?? "", tools);

    let finalText: string;
    let recoSlug: string | null = null;

    if (chosen) {
      // Replace model output with a clean internal plan and canonical Try line
      finalText = `${renderPlanForTool(chosen)}\n\n${formatTryLine(chosen)}`.trim();
      recoSlug = (chosen as any).slug || null;
    } else {
      // Non-tools path (or no valid internal match): strip Try lines and external mentions, keep neutral guidance
      const scrubbed = removeExternalToolMentions(stripAllTryLines(out?.text ?? ""), allow);
      finalText = scrubbed;
    }

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

    // ---- headers ----
    headers["X-Route"] = String(out?.route ?? decision.route);
    headers["X-RAG"] = String(!!(decision?.ragMeta?.count ?? 0));
    headers["X-RAG-Count"] = String(decision?.ragMeta?.count ?? 0);
    if (decision?.ragMeta?.mode) headers["X-RAG-Mode"] = String(decision.ragMeta.mode);
    if (decision?.ragMeta?.model) headers["X-Embed-Model"] = String(decision.ragMeta.model);
    headers["X-Reco"] = String(!!out?.reco);
    if (out?.meta?.recoSlug) headers["X-Reco-Slug"] = String(out.meta.recoSlug);

    // ---- telemetry ----
    const duration = Date.now() - t0;
    headers["X-Duration-Total"] = String(duration);
    try {
      if (!sb) {
        headers["X-Events"] = "no-sb";
      } else {
        const { error } = await sb.from("events").insert({
          q: userText.slice(0, 500),
          route: out?.route ?? decision.route,
          rag_count: decision?.ragMeta?.count ?? 0,
          rag_mode: decision?.ragMeta?.mode ?? null,
          model: decision?.ragMeta?.model ?? null,
          reco_slug: out?.meta?.recoSlug ?? null,
          duration_ms: duration,
          ok: true,
        });
        if (error) {
          headers["X-Events"] = "err";
          headers["X-Events-Err"] = String((error as any).code ?? "insert_error");
          headers["X-Events-Msg"] = String((error as any).message ?? "").slice(0, 120);
        } else {
          headers["X-Events"] = "ok";
        }
      }
    } catch (e: any) {
      headers["X-Events"] = "threw";
      headers["X-Events-Err"] = String(e?.name ?? "throw");
      headers["X-Events-Msg"] = String(e?.message ?? "").slice(0, 120);
    }

    headers["X-Events-Stage"] = "success";
    return { statusCode: 200, headers, body: out?.text || "" };
  } catch (err: any) {
    const duration = Date.now() - t0;
    headers["X-Duration-Total"] = String(duration);

    // log failure
    try {
      if (sb) {
        await sb.from("events").insert({
          q: userText.slice(0, 500),
          route: out?.route ?? null,
          rag_count: out?.meta?.rag ?? 0,
          rag_mode: out?.meta?.ragMode ?? null,
          model: out?.meta?.model ?? null,
          reco_slug: out?.meta?.recoSlug ?? null,
          duration_ms: duration,
          ok: false,
          err: String(err?.stack || err?.message || err || "unknown"),
        });
        headers["X-Events"] = "ok";
      } else {
        headers["X-Events"] = "no-sb";
      }
    } catch (e: any) {
      headers["X-Events"] = "threw";
      headers["X-Events-Err"] = String(e?.name ?? "throw");
      headers["X-Events-Msg"] = String(e?.message ?? "").slice(0, 120);
    }

    headers["X-Events-Stage"] = "error";

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
