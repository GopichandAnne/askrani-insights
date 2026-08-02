import { getLlm, isLlmConfigured } from "@/lib/extraction/llm";

/**
 * "Act on it" — turn a recommended move (an Edge leverage action or a
 * recommendation) into ready-to-use marketing copy a busy owner can post in
 * seconds: a social caption, an in-store/sign promo line, an SMS blast, and
 * hashtags. Grounded in the owner's business + the specific move; no placeholders.
 */

export interface Draft {
  caption: string;
  promoLine: string;
  sms: string;
  hashtags: string[];
}

const SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    caption: { type: "string", description: "A ready-to-post Instagram/Facebook caption (2–4 short lines, warm, on-brand, 1–3 emojis). If the move is a deal, state it clearly. No placeholders like [X]." },
    promoLine: { type: "string", description: "One punchy line for an in-store sign or table tent (≤12 words)." },
    sms: { type: "string", description: "A short SMS/WhatsApp blast to regulars (≤160 chars), with a clear call to action." },
    hashtags: { type: "array", items: { type: "string" }, description: "5–8 relevant hashtags (mix local + category), no '#' needed." },
  },
  required: ["caption", "promoLine", "sms", "hashtags"],
};

export async function generateDraft(input: {
  business: string;
  vertical: string;
  city?: string;
  move: string; // the action/idea to turn into copy
  context?: string; // optional extra context (competitor, why)
}): Promise<Draft | { error: string }> {
  if (!isLlmConfigured()) return { error: "AI isn't configured yet." };
  const system = [
    `You are the social-media manager for "${input.business}", a local ${input.vertical}${input.city ? ` in ${input.city}` : ""}.`,
    "Write ready-to-USE marketing copy — the owner will paste it as-is. Warm, specific, plain English, lightly on-trend. No placeholders, no brackets, no 'insert here'.",
    "If the move implies an offer, invent a reasonable, clearly-stated deal the owner can honor; keep numbers realistic for this business type.",
  ].join(" ");
  const text = `Turn this move into copy.\n\nMOVE: ${input.move}${input.context ? `\nCONTEXT: ${input.context}` : ""}`;
  try {
    const { data } = await getLlm().callStructured<Draft>({ system, text, schema: SCHEMA, tier: "extract", maxTokens: 600 });
    return {
      caption: String(data.caption ?? "").trim(),
      promoLine: String(data.promoLine ?? "").trim(),
      sms: String(data.sms ?? "").trim(),
      hashtags: Array.isArray(data.hashtags) ? data.hashtags.map((h) => String(h).replace(/^#/, "")).slice(0, 8) : [],
    };
  } catch (e) {
    return { error: (e as Error).message };
  }
}
