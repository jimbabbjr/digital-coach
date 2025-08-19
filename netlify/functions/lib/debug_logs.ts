// netlify/functions/lib/debug_logs.ts
import { createClient } from "@supabase/supabase-js";

const sb =
  process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY
    ? createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!)
    : null;

const DEBUG_LOGS_TABLE = process.env.DEBUG_LOGS_TABLE || "debug_logs";

/**
 * Appends a user+assistant turn to debug_logs, one row per conversation_id.
 * Schema matches your edge function: label, conversation_id, conversation_history[], updated_at.
 */
export async function appendTurnToDebugLogs(args: {
  conversationId: string;          // usually your sessionId
  userText: string;
  assistantText: string;
}) {
  if (!sb) return;
  const { conversationId, userText, assistantText } = args;

  try {
    // Pull current history (if any)
    const { data } = await sb
      .from(DEBUG_LOGS_TABLE)
      .select("conversation_history")
      .eq("conversation_id", conversationId)
      .maybeSingle();

    const history = Array.isArray((data as any)?.conversation_history)
      ? (data as any).conversation_history
      : [];

    // Append this turn
    history.push({ role: "user", content: String(userText || "") });
    history.push({ role: "assistant", content: String(assistantText || "") });

    // Upsert row (conflict on conversation_id), same shape your edge function uses
    await sb
      .from(DEBUG_LOGS_TABLE)
      .upsert(
        {
          label: "conversation",
          conversation_id: conversationId,
          conversation_history: history,
          updated_at: new Date().toISOString(),
        } as any,
        { onConflict: "conversation_id" }
      );
  } catch {
    // best-effort logging; never break the reply
  }
}
