// netlify/functions/chat.ts
import type { Handler } from "@netlify/functions";
import { createClient } from "@supabase/supabase-js";

import { route as pickRoute } from "./lib/agents/router";
import { QaAgent } from "./lib/agents/qa";
import { CoachAgent } from "./lib/agents/coach";
import { ToolsAgent } from "./lib/agents/tools";

import {
  getToolRegistry,
  detectToolFromAssistant,
  matchToolByIntent,
  formatTryLine,
  type ToolDoc,
} from "./lib/tools";

/* ------------------------- helpers ------------------------- */
function stripAllTryLines(text: string): string {
  return (text || "")
    .split("\n")
    .filter((ln) => !/^\s*Try:/i.test(ln))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function stripExternalLinks(text: string): string {
  if (!text) return "";
  const dom = /\b[a-z0-9-]+\.(?:com|io|ai|app|co|org|net)\b/i;
  const http = /\bhttps?:\/\//i;
  const kept = text.split("\n").filter((ln) => !(dom.test(ln) || http.test(ln)));
  return kept.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

function renderPlanForTool(tool: ToolDoc): string {
  const why = tool.why || "built for this job—low friction, consistent results";
  const outcome =
    tool.outcome || "reliable weekly signal without manual chasing or nagging";

  return [
    `Here’s the fastest path using **${tool.title}**:`,
    "",
    "- **Set the rhythm:** Pick one submission deadline (e.g., Fridays 3pm).",
    "- **Use the built-in template:** Keep it to wins, blockers, next week.",
    "- **Auto-nudge once:** Let the tool send a single reminder before the deadline.",
    "- **Model the habit:** Post your own update first.",
    "- **Close the loop:** Share highlights next week to show the value.",
    "",
    `Result: ${outcome}.`,
  ].join("\n");
}

function findPriorAssistantTool(messages: any[], tools: ToolDoc[]): ToolDoc | null {
  const lastAssistant = [...(messages || [])]
    .reverse()
    .find((m) => m?.role === "assistant" && typeof m?.content === "string");
  return lastAssistant ? detectToolFromAssistant(String(lastAssistant.content), tools) : null;
}

function matchFromUserHistory(messages: any[], tools: ToolDoc[]): ToolDoc | null {
  const history = (messages || [])
    .filter((m) => m?.role === "user" && typeof m?.content === "string")
    .map((m) => String(m.content))
    .join("\n\n");
  return history ? matchToolByIntent(history, tools) : null;
}

/* -------------------- telemetry (optional) -------------------- */
const sb =
  process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY
    ? createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!)
    : null;

const agents = { qa: QaAgent, coach: CoachAgent, tools: ToolsAgent } as const;

/* =============================== handler =============================== */
export const handler: Handler = async (event) => {
  const t0 = Date.now();

  // bump this whenever your enforcement policy changes
  const POLICY_VERSION = "int-tools-hard-override-v1";
  const DEBUG_STAMP = String(Date.now()); // canary so you know which code ran

  // single headers object for all returns
  const headers: Record<string, string> = {
    "Content-Type": "text/plain; charset=utf-8",
    // include legacy 'X-Model' for back-compat; add our new headers explicitly
    "Access-Control-Expose-Headers":
      "X-Route, X-RAG, X-RAG-Count, X-RAG-Mode, X-Embed-Model, X-Model, X-Reco, X-Reco-Slug, X-Duration-Total, X-Events, X-Events-Err, X-Events-Msg, X-Events-Stage, X-Policy-Version, X-Debug-Stamp",
    "X-Policy-Version": POLICY_VERSION,
    "X-Debug-Stamp": DEBUG_STAMP,
  };
  headers["X-Events"] = "boot";
  headers["X-Events-Stage"] = "start";

  // one exit to guarantee headers on every path
  const finalize = (statusCode: number, body: string) => {
    headers["X-Policy-Version"] = POLICY_VERSION;
    headers["X-Debug-Stamp"] ||= DEBUG_STAMP;
    return { statusCode, headers, body };
  };

  if (event.httpMethod !== "POST") {
    headers["X-Events-Stage"] = "405";
    return finalize(405, "Method Not Allowed");
  }

  let userText = "";
  let out:
    | {
        text: string;
        route: keyof typeof agents | string;
        reco?: boolean;
        meta?: {
          rag?: number;
          ragMode?: string | null;
          model?: string | null;
          recoSlug?: string | null;
        };
      }
    | null = null;

  try {
    /* --------------------------- parse body --------------------------- */
    const body = event.body ? JSON.parse(event.body) : {};
    const clientMessages = Array.isArray(body?.messages) ? body.messages : [];
    userText =
      body?.q ??
      [...clientMessages]
        .reverse()
        .find((m: any) => m?.role === "user" && typeof m?.content === "string")
        ?.content ??
      "";
    userText = String(userText).trim();
    headers["X-Events-Stage"] = "parsed";

    if (!userText) {
      return finalize(400, "Bad Request: missing user text");
    }

    /* ----------------------- route & run agent ----------------------- */
    const decision = await pickRoute(userText, clientMessages as any);

    if (decision.route === "qa") {
      out = await QaAgent.handle({
        userText,
        messages: clientMessages,
        ragSpans: decision.ragSpans,
      });
    } else if (decision.route === "tools") {
      out = await ToolsAgent.handle({ userText, messages: clientMessages });
    } else {
      out = await CoachAgent.handle({ userText, messages: clientMessages });
    }

    /* --------- internal-only enforcement with turn memory --------- */
    const tools = await getToolRegistry();

    let chosen =
      matchToolByIntent(userText, tools) ||
      detectToolFromAssistant(out?.text ?? "", tools) ||
      findPriorAssistantTool(clientMessages, tools) ||
      matchFromUserHistory(clientMessages, tools);

    let finalText: string;
    let recoSlug: string | null = null;

    if (chosen) {
      const plan = renderPlanForTool(chosen);
      finalText = `${plan}\n\n${formatTryLine(chosen)}`.trim();
      recoSlug = chosen.slug || null;
    } else {
      finalText = stripExternalLinks(stripAllTryLines(out?.text ?? ""));
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

    /* --------------------------- headers --------------------------- */
    headers["X-Route"] = String(out?.route ?? decision.route);
    headers["X-RAG"] = String(!!(decision?.ragMeta?.count ?? 0));
    headers["X-RAG-Count"] = String(decision?.ragMeta?.count ?? 0);
    if (decision?.ragMeta?.mode) headers["X-RAG-Mode"] = String(decision.ragMeta.mode);
    if (decision?.ragMeta?.model) headers["X-Embed-Model"] = String(decision.ragMeta.model);
    headers["X-Reco"] = String(!!out?.reco);
    if (out?.meta?.recoSlug) headers["X-Reco-Slug"] = String(out.meta.recoSlug);

    const duration = Date.now() - t0;
    headers["X-Duration-Total"] = String(duration);

    /* -------------------------- telemetry -------------------------- */
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

    /* ---------------------- debug echo (body) ---------------------- */
    const dbg = event.queryStringParameters?.debug === "1";
    if (dbg) {
      const echo = {
        policy: headers["X-Policy-Version"] || null,
        debugStamp: headers["X-Debug-Stamp"] || null,
        route: headers["X-Route"] || null,
        rag: headers["X-RAG"] || null,
        ragCount: headers["X-RAG-Count"] || null,
        reco: headers["X-Reco"] || null,
        recoSlug: headers["X-Reco-Slug"] || null,
      };
      out.text = `[[DEBUG ${JSON.stringify(echo)}]]\n\n` + (out?.text || "");
    }

    headers["X-Events-Stage"] = "success";
    return finalize(200, out?.text || "");
  } catch (err: any) {
    const duration = Date.now() - t0;
    headers["X-Duration-Total"] = String(duration);

    try {
      if (sb) {
        await sb.from("events").insert({
          q: (typeof err?.q === "string" ? err.q : "").slice(0, 500),
          route: null,
          rag_count: 0,
          rag_mode: null,
          model: null,
          reco_slug: null,
          duration_ms: duration,
          ok: false,
          err: String(err?.code ?? err?.message ?? "unknown"),
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
    return finalize(500, "Internal Server Error");
  }
};
