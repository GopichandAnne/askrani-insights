import { getLlm, isLlmConfigured } from "@/lib/extraction/llm";
import { generateDraft, type Draft } from "@/lib/draft";
import type { ActKind } from "@/lib/digest";

/**
 * "Act on it" — the loop that closes insight → action. Every actionable insight
 * (a review to answer, a competitor deal to counter, a content idea) becomes a
 * ready-to-use artifact the owner can send in one tap:
 *   - reply   → a warm, specific reply to a customer review
 *   - promo   → marketing copy to counter a move / run an offer (via draft.ts)
 *   - content → a post for a content idea / gap (via draft.ts)
 * This is what makes the intelligence payable: it doesn't just tell the owner
 * what's happening, it does the next step for them. Artifacts are grounded in the
 * business + the specific move; no placeholders.
 */

export interface ReviewReply { reply: string; tone: string }
export type ActionArtifact =
  | ({ kind: "reply" } & ReviewReply)
  | ({ kind: "promo" | "content" } & Draft);

const REPLY_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    reply: { type: "string", description: "A warm, specific, professional reply the owner can post as-is (2–4 sentences). Thank the reviewer, address their point concretely, invite them back. If the review is negative, own it graciously and offer to make it right — never defensive. No placeholders/brackets." },
    tone: { type: "string", description: "One word for the tone chosen (e.g. grateful, apologetic, upbeat)." },
  },
  required: ["reply", "tone"],
};

async function generateReviewReply(input: { business: string; vertical: string; city?: string; move: string; context?: string }): Promise<ReviewReply | { error: string }> {
  if (!isLlmConfigured()) return { error: "AI isn't configured yet." };
  const system = [
    `You are the owner of "${input.business}", a local ${input.vertical}${input.city ? ` in ${input.city}` : ""}, personally replying to a customer review.`,
    "Write in first person, warm and human — the owner will post it verbatim. No corporate boilerplate, no placeholders or brackets.",
  ].join(" ");
  const text = `${input.move}${input.context ? `\n\nContext: ${input.context}` : ""}`;
  try {
    const { data } = await getLlm().callStructured<ReviewReply>({ system, text, schema: REPLY_SCHEMA, tier: "extract", maxTokens: 400 });
    return { reply: String(data.reply ?? "").trim(), tone: String(data.tone ?? "").trim() };
  } catch (e) {
    return { error: (e as Error).message };
  }
}

export async function generateAction(input: {
  business: string; vertical: string; city?: string; kind: ActKind; move: string; context?: string;
}): Promise<ActionArtifact | { error: string }> {
  if (input.kind === "reply") {
    const r = await generateReviewReply(input);
    return "error" in r ? r : { kind: "reply", ...r };
  }
  const d = await generateDraft(input);
  return "error" in d ? d : { kind: input.kind, ...d };
}
