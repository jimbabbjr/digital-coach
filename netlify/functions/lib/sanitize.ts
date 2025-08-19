// netlify/functions/lib/sanitize.ts
import type { ToolDoc } from "./tools";

/** Normalize for fuzzy compares */
function norm(s: string) {
  return String(s || "")
    .toLowerCase()
    .replace(/\btool\b/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/** Build an allowlist of internal tool names from tool_docs */
export function buildAllowlist(tools: ToolDoc[]): Set<string> {
  const allow = new Set<string>();
  for (const t of tools) if (t?.title) allow.add(norm(t.title));
  return allow;
}

/** Light fuzzy compare to see if a candidate equals an internal tool title */
function isAllowedTitle(candidate: string, allow: Set<string>): boolean {
  const nc = norm(candidate);
  if (!nc) return false;
  if (allow.has(nc)) return true;

  // light fuzzy: token overlap >= 0.7
  const ca = new Set(nc.split(" "));
  for (const a of allow) {
    const aa = new Set(a.split(" "));
    let overlap = 0;
    for (const w of ca) if (aa.has(w)) overlap++;
    const score = overlap / Math.max(aa.size, ca.size, 1);
    if (score >= 0.7) return true;
  }
  return false;
}

/** Remove model-added Try lines */
export function stripAllTryLines(text: string): string {
  return (text || "")
    .split("\n")
    .filter((ln) => !/^\s*Try:/i.test(ln))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * Extract brand-like candidates from a line:
 * - Domains
 * - 1–3 Capitalized Words (e.g., "Google Forms", "Microsoft Teams", "Range")
 */
function extractBrandCandidates(line: string): string[] {
  const out: string[] = [];

  // Domains
  const domRe = /\b[a-z0-9-]+\.(?:com|io|ai|app|co|org|net)\b/gi;
  let m: RegExpExecArray | null;
  while ((m = domRe.exec(line))) out.push(m[0]);

  // Capitalized sequences (avoid weekday/sentence starters)
  const capRe = /\b([A-Z][a-z0-9]+(?:\s+[A-Z][a-z0-9]+){0,2})\b/g;
  const stop = new Set([
    "I","We","Our","A","An","The","This","That",
    "Monday","Tuesday","Wednesday","Thursday","Friday","Saturday","Sunday",
  ]);
  while ((m = capRe.exec(line))) {
    const phrase = m[1].trim();
    if (!stop.has(phrase)) out.push(phrase);
  }
  return out;
}

/** True if a line is clearly suggesting an *external* product */
function isExternalToolLine(line: string, allow: Set<string>): boolean {
  const lc = line.toLowerCase();

  // Obvious hints it’s about picking/using a product
  const hint =
    /\b(use|via|choose|pick|select|set\s*up|setup|install|integrate|connect|leverage|with)\b/i.test(line) ||
    /\b(form|tool|app|bot|platform|software|plug[-\s]?in)\b/i.test(lc) ||
    /\bstand[-\s]?up|check[-\s]?in|report|updates?\b/i.test(lc) ||
    /\b(or|alternatively)\b/i.test(lc) ||
    /\bhttps?:\/\//i.test(line) ||
    /\b[a-z0-9-]+\.(?:com|io|ai|app|co|org|net)\b/i.test(line);

  if (!hint) return false;

  const brands = extractBrandCandidates(line);
  if (!brands.length) return false;

  // If any candidate is NOT an allowed internal tool, treat as external.
  return brands.some((b) => !isAllowedTitle(b, allow));
}

/** Remove lines that promote specific external tools (keep neutral guidance) */
export function removeExternalToolMentions(text: string, allow: Set<string>): string {
  if (!text) return "";
  const kept = (text.split("\n")).filter((ln) => !isExternalToolLine(ln, allow));
  return kept.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

/**
 * Enforce a house tool:
 * - Drop lines that mention external brands
 * - Rewrite generic "pick/use a tool" lines into "Use <Internal Tool>"
 * - Keep everything else
 */
export function enforceInternalTool(
  text: string,
  allow: Set<string>,
  chosenTitle: string
): string {
  if (!text) return "";
  const lines = text.split("\n");

  const genericToolRe =
    /^\s*(?:[-•]|\d+[\.\)])?\s*(?:pick|choose|use|leverage|set\s*up|setup|select)\b.*\b(tool|form|doc|sheet|board|workspace|check[-\s]?in app|task tracker|team chat)\b/i;

  const result: string[] = [];
  for (let ln of lines) {
    // If line suggests an external brand → drop it completely
    if (isExternalToolLine(ln, allow)) continue;

    // If line is a generic choose/use-a-tool line → rewrite to house tool
    if (genericToolRe.test(ln)) {
      ln = ln.replace(genericToolRe, `Use **${chosenTitle}** for this`);
    }

    result.push(ln);
  }

  // collapse blank runs
  return result.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}
// --- add near the bottom of sanitize.ts ---

/** Renumber contiguous ordered-list blocks (1., 2., 3.) after filtering */
export function renumberOrderedLists(text: string): string {
  if (!text) return "";
  const lines = text.split("\n");

  const numRe = /^\s*(\d+)[\.\)]\s+/;  // 1.  or 1)
  let inBlock = false;
  let n = 0;

  for (let i = 0; i < lines.length; i++) {
    const ln = lines[i];

    if (numRe.test(ln)) {
      if (!inBlock) { inBlock = true; n = 1; } else { n += 1; }
      lines[i] = ln.replace(numRe, `${n}. `);
      continue;
    }

    // reset when we hit a blank line or a bullet/subheading
    if (!ln.trim() || /^\s*[-•]/.test(ln) || /^\s*#{1,6}\s/.test(ln)) {
      inBlock = false; n = 0;
    }
  }

  return lines.join("\n");
}

/** One-shot cleanup for neutral guidance: strip Try lines & externals, then renumber */
export function sanitizeNeutralGuidance(text: string, allow: Set<string>): string {
  const stripped = removeExternalToolMentions(stripAllTryLines(text), allow);
  return renumberOrderedLists(stripped);
}

