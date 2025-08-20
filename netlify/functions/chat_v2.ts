// netlify/functions/chat_v2.ts
/* eslint-disable @typescript-eslint/no-explicit-any */

import type { Handler } from "@netlify/functions";
import { rankTools } from "./lib/tool-select";
import { composeReply } from "./lib/composer";
import { composeToolPlan } from "./lib/plan-compose";
import type { Reply } from "./lib/reply-schema";

/** Utilities */

function isAffirmative(s: string) {
  const x = String(s || "").toLowerCase();
  return /\b(yes|yep|sure|sounds good|do it|let'?s (go|try|do) (it)?|ok(ay)?|go ahead|please do)\b/.test(x);
}

function isMediaAsk(s: string) {
  return /\b(book|books|author|reading\s*list|recommend( me|ation)?s?|podcast|article|course|courses?)\b/i.test(
    String(s || "")
  );
}

function parseBody(raw: any) {
  if (!raw) return {};
  try {
    return typeof raw === "string" ? JSON.parse(raw) : raw;
  } catch {
    return {};
  }
}

/** Tool catalog loader (very light). Prefer to pass it in request; otherwise empty. */
type ToolCatalog = Record<string, { title: string; description: string; defaultSlots?: Record<string, any> }>;

function asToolArray(catalog: ToolCatalog) {
  return Object.entries(catalog || {}).map(([slug, t]) => ({
    slug,
    title: t.title || slug,
    description: t.description || "",
  }));
}

/** Renderers (no hard-coded plans) */

function renderMedia(reply: Extract<Reply, { mode: "media_recs" }>) {
  const items = (reply.items || [])
    .map(
      (i) =>
        `- **${i.title}**${i.by ? ` (${i.by})` : ""} — ${i.why} _Takeaway:_ ${i.takeaway}`
    )
    .join("\n");
  const tail = reply.ask ? `\n\n${reply.ask}` : "";
  return `${reply.message}\n\n${items}${tail}`.trim();
}

function renderOfferTool(reply: Extract<Reply, { mode: "offer_tool" }>) {
  // Ask-first suggestion; no deterministic plan text anywhere.
  const pct = Math.round((reply.confidence ?? 0) * 100);
  const conf = Number.isFinite(pct) && pct > 0 ? ` (confidence ${pct}%)` : "";
  return `${reply.message}\n\n**${reply.tool_slug}**${conf}\n${reply.confirm_cta}`;
}

/** Core processor */

async function processChatV2(payload: any) {
  const userText: string = String(payload.q ?? payload.query ?? "").trim();
  const messages: Array<{ role: "user" | "assistant"; content: string }> = payload.messages ?? [];
  const toolCatalog: ToolCatalog = payload.toolCatalog ?? {};
  const confirmToolSlug: string | null = payload.confirm_tool_slug ?? null; // optional confirmation step
  const approvalText: string | null = payload.approval_text ?? null; // optional user approval phrase

  if (!userText && !confirmToolSlug) {
    return {
      status: 400,
      json: { error: "Missing 'q' (user text)" },
    };
  }

  const tools = asToolArray(toolCatalog);
  const candidates = tools.length ? await rankTools(userText, tools) : [];

  // If this request is an explicit confirmation to configure a tool (optional flow)
  if (confirmToolSlug) {
    const meta = toolCatalog[confirmToolSlug] || { title: confirmToolSlug, description: "" };
    const plan = await composeToolPlan({
      approvalText: approvalText || userText,
      tool_slug: confirmToolSlug,
      toolMeta: meta,
    });
    // Caller can execute this plan; we only describe briefly.
    const msg =
      plan.message ||
      `I'll configure **${meta.title || confirmToolSlug}** with: ${JSON.stringify(plan.slots)}`;
    return {
      status: 200,
      json: {
        route: "tools",
        impl: "composer-v1",
        text: msg,
        reco: false, // still ask-first; execution happens after UI confirms
        recoSlug: confirmToolSlug,
        plan,
        meta: { composer: "composeToolPlan", model: process.env.OPENAI_CHAT_MODEL || "gpt-4o-mini" },
      },
    };
  }

  // Compose the reply (model decides mode; no hard-coded path)
  const reply: Reply = await composeReply({
    userText,
    candidates,
    toolCatalog,
    model: process.env.OPENAI_CHAT_MODEL || "gpt-4o-mini",
  });

  // Map reply to route + text (no canned Weekly Report plan anywhere)
  let route: "qa" | "coach" | "tools" = "qa";
  let text = "";
  let reco = false;
  let recoSlug: string | null = null;

  switch (reply.mode) {
    case "media_recs":
      route = "qa";
      text = renderMedia(reply);
      reco = false;
      break;

    case "offer_tool":
      // Ask-first suggestion (no plan): user must explicitly confirm later.
      route = "tools";
      text = renderOfferTool(reply);
      reco = false; // never auto-reco/execute
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

  // Sticky behavior is disabled unless the last user explicitly affirmed
  const lastUser = [...messages].reverse().find((m) => m.role === "user")?.content ?? "";
  const allowSticky = isAffirmative(lastUser);
  if (!allowSticky) {
    // do nothing special; 'reco' stays false unless explicitly confirmed later
  }

  const meta = {
    composer: "composeReply",
    model: process.env.OPENAI_CHAT_MODEL || "gpt-4o-mini",
    isMediaAsk: isMediaAsk(userText),
  };

  return {
    status: 200,
    json: {
      route,
      impl: "composer-v1",
      text,
      reco,
      recoSlug,
      candidates,
      reply, // raw structured reply (schema)
      meta,
    },
  };
}

/** Netlify v1 handler */
export const handler: Handler = async (event) => {
  if (event.httpMethod !== "POST") {
    return { statusCode: 405, body: "Method Not Allowed" };
  }
  const payload = parseBody(event.body);
  try {
    const out = await processChatV2(payload);
    return { statusCode: out.status, body: JSON.stringify(out.json) };
  } catch (err: any) {
    return {
      statusCode: 500,
      body: JSON.stringify({ error: err?.message || "Internal error" }),
    };
  }
};

/** Netlify v2 default export (compatible) */
export default (async (req: Request) => {
  if (req.method !== "POST") {
    return new Response("Method Not Allowed", { status: 405 });
  }
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
