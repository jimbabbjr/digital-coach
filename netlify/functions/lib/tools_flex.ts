// netlify/functions/lib/tools_flex.ts
import type { SupabaseClient } from "@supabase/supabase-js";

export type ToolDocNorm = {
  slug: string;
  title: string;
  summary?: string | null;
  why?: string | null;
  outcome?: string | null;
  keywords?: string[] | string | null;
  patterns?: string[] | string | null;
  enabled: boolean;
};

/** kebab-case from a few possible name fields */
function kebab(s?: string | null) {
  return String(s ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function toList(x: unknown): string[] {
  if (Array.isArray(x)) return x.map(v => String(v).trim()).filter(Boolean);
  if (x == null) return [];
  const s = String(x);
  if (s.startsWith("{") && s.endsWith("}")) {
    // pg text[] string form -> {a,b} ; strip braces and split
    return s.slice(1, -1).split(",").map(v => v.trim()).filter(Boolean);
  }
  return s.split(",").map(v => v.trim()).filter(Boolean);
}

function coalesce<T>(...vals: T[]): T | undefined {
  for (const v of vals) if (v !== undefined && v !== null && String(v) !== "") return v;
  return undefined;
}

function isEnabledRow(row: any): boolean {
  // accept a variety of flags your existing table might use
  const v = row?.enabled ?? row?.is_enabled ?? row?.active ?? row?.is_active ?? row?.status;
  if (typeof v === "boolean") return v;
  if (typeof v === "string") return ["1","true","t","y","yes","active","enabled"].includes(v.toLowerCase());
  if (typeof v === "number") return v > 0;
  // default to true so we don't hide rows accidentally
  return true;
}

/** Normalize one raw DB row into the shape the app expects */
export function normalizeToolRow(row: any): ToolDocNorm | null {
  if (!row) return null;

  const title =
    coalesce<string>(
      row.title,
      row.tool_name,
      row.name,
      row.display_name
    ) ?? "";

  const slug =
    coalesce<string>(
      row.slug,
      row.tool_slug,
      row.code,
      kebab(title),
    ) ?? "";

  if (!title || !slug) return null;

  const summary = coalesce<string>(row.summary, row.primary_use, row.description);
  const why     = coalesce<string>(row.why, row.value_prop, row.reason);
  const outcome = coalesce<string>(row.outcome, row.result);

  const keywords = toList(row.keywords ?? row.tags ?? row.search_terms);
  const patterns = toList(row.patterns ?? row.regex ?? row.matchers);

  return {
    slug,
    title,
    summary: summary ?? null,
    why:     why ?? null,
    outcome: outcome ?? null,
    keywords: keywords.length ? keywords : null,
    patterns: patterns.length ? patterns : null,
    enabled: isEnabledRow(row),
  };
}

/** Fetch tools using a broad select and normalize to the contract this app needs. */
export async function fetchToolRegistryFlexible(sb: SupabaseClient | null): Promise<ToolDocNorm[]> {
  if (!sb) return [];
  // broad select: we don't filter by "enabled" here because the column name varies
  const { data, error } = await sb.from("tool_docs").select("*");
  if (error || !data) return [];

  const out: ToolDocNorm[] = [];
  for (const row of data as any[]) {
    const t = normalizeToolRow(row);
    if (t && t.enabled) out.push(t);
  }
  return out;
}
