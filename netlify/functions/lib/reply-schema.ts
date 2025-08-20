// netlify/functions/lib/reply-schema.ts
export type MediaItem = { title: string; by?: string; why: string; takeaway: string };

export type Reply =
  | {
      mode: "media_recs";
      message: string;
      items: MediaItem[];
      ask?: string;
    }
  | {
      mode: "offer_tool";
      tool_slug: string;
      confidence: number; // 0..1
      slots?: Record<string, string | number | boolean>;
      message: string;     // short value pitch
      confirm_cta: string; // e.g., "Want me to set this up? (Yes / No)"
      requires_confirmation: true;
    }
  | {
      mode: "deep_dive";   // user referenced an item from a prior list
      message: string;     // full markdown with concrete steps/templates
    }
  | {
      mode: "qa" | "coach";
      message: string;
    };
