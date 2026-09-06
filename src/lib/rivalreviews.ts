import { staleCached } from "@/lib/staleCache";
import { createClient, type RlsClient } from "@/lib/supabase/server";
import { getLlm, isLlmConfigured } from "@/lib/extraction/llm";
import { workspaceBusinessIds, type WorkspaceRow } from "@/lib/workspace";

/**
 * Rival review-mining — "what customers punish your competitors for." We read the
 * COMPETITORS' own reviews (content_item, google/yelp) + Google's full-corpus
 * summary per rival, and one LLM pass distills the recurring COMPLAINTS (each an
 * opening you can win those customers with — with a concrete angle) and the
 * recurring PRAISE (table stakes you must match). Grounded strictly in the rivals'
 * reviews — never invented. Read-only over already-collected data (no scrape/cost
 * beyond the one LLM call). Hardened like the other pillars: a failed AI read is
 * flagged (never cached as final) so it self-heals next refresh.
 */

const clean = (s: unknown) => String(s ?? "").replace(/<\/?[a-z][^>]*>/gi, "").replace(/\s+/g, " ").trim();
const RATING_RE = /Rated\s+([\d.]+)\s*★.*?from\s+([\d,]+)\s+review/i;

export interface RivalGap { theme: string; rivals: string[]; evidence: string; angle: string }
export interface RivalStrength { theme: string; rivals: string[] }
export interface RivalReviewMining {
  gaps: RivalGap[];          // recurring complaints about rivals = openings to win their customers
  strengths: RivalStrength[]; // recurring praise = table stakes to match
  summary: string;
  rivalsRead: number;
  at: string;
  empty?: boolean;
  failed?: boolean;
}

const SCHEMA = {
  type: "object", additionalProperties: false,
  properties: {
    gaps: {
      type: "array", maxItems: 5,
      description: "Recurring COMPLAINTS across the rivals' reviews — each an opening for this business. Only themes actually present in the reviews.",
      items: {
        type: "object", additionalProperties: false,
        properties: {
          theme: { type: "string", description: "the complaint in 2-5 words, e.g. 'long wait times', 'stale produce', 'rude staff'." },
          rivals: { type: "array", items: { type: "string" }, description: "which named rivals this complaint shows up for (copy names verbatim from the input)." },
          evidence: { type: "string", description: "one short paraphrase of what reviewers say (no direct quotes longer than a few words)." },
          angle: { type: "string", description: "one concrete sentence: how THIS business should lean into being better on exactly this, to win those customers." },
        }, required: ["theme", "rivals", "evidence", "angle"],
      },
    },
    strengths: {
      type: "array", maxItems: 4,
      description: "Recurring PRAISE across the rivals' reviews — what you must match to compete. Only themes actually present.",
      items: {
        type: "object", additionalProperties: false,
        properties: {
          theme: { type: "string", description: "the praised thing in 2-5 words, e.g. 'fast checkout', 'friendly staff'." },
          rivals: { type: "array", items: { type: "string" }, description: "which named rivals are praised for it." },
        }, required: ["theme", "rivals"],
      },
    },
    summary: { type: "string", description: "1-2 plain sentences: the single biggest opening in the rivals' weaknesses, and the biggest bar they set." },
  },
  required: ["gaps", "strengths", "summary"],
};

const SYSTEM =
  "You are a local-market analyst. Given the REVIEWS of a business's direct COMPETITORS, find (1) the recurring COMPLAINTS — what customers punish those rivals for, each an opening this business can win on, with a concrete angle; and (2) the recurring PRAISE — what rivals are loved for, which this business must match. Ground everything ONLY in the rivals' reviews provided; never invent, and attribute each theme to the named rivals it actually appears for. Plain, practical language; no fluff, no long quotes.";

const empty = (at: string, failed = false): RivalReviewMining => ({ gaps: [], strengths: [], summary: "", rivalsRead: 0, at, empty: true, ...(failed ? { failed: true } : {}) });

export async function generateRivalReviews(ws: WorkspaceRow, db?: RlsClient): Promise<RivalReviewMining> {
  const at = new Date().toISOString();
  const supabase = db ?? (await createClient());
  const ids = await workspaceBusinessIds(ws, supabase);
  if (!ids.competitorIds.length) return empty(at);

  // rival names + Google full-corpus summaries, and their individual reviews
  const [{ data: bizRows }, { data: revRows }] = await Promise.all([
    supabase.from("business").select("id, canonical_name, attributes").in("id", ids.competitorIds),
    supabase.from("content_item").select("business_id, text").in("business_id", ids.competitorIds).in("platform", ["google", "yelp"]).order("published_at", { ascending: false, nullsFirst: false }).limit(150),
  ]);
  const nameById = new Map<string, string>(((bizRows ?? []) as any[]).map((b) => [b.id as string, clean(b.canonical_name) || "a competitor"]));

  // group review snippets per rival (cap per rival so one loud rival can't dominate)
  const perRival = new Map<string, string[]>();
  for (const r of (revRows ?? []) as any[]) {
    const t = clean(r.text);
    if (t.length <= 15 || RATING_RE.test(t)) continue;
    const name = nameById.get(r.business_id as string) ?? "a competitor";
    const arr = perRival.get(name) ?? perRival.set(name, []).get(name)!;
    if (arr.length < 12) arr.push(t.slice(0, 240));
  }
  const summaries: string[] = ((bizRows ?? []) as any[])
    .map((b) => { const s = clean((b.attributes as any)?.googleReviewSummary?.text); return s ? `${nameById.get(b.id) ?? "rival"}: ${s}` : ""; })
    .filter(Boolean);

  const rivalsRead = new Set([...perRival.keys(), ...summaries.map((s) => s.split(":")[0])]).size;
  if (!perRival.size && !summaries.length) return empty(at);
  if (!isLlmConfigured()) return empty(at);

  const reviewBlock = [...perRival.entries()].map(([name, snips]) => `--- ${name} ---\n${snips.join("\n")}`).join("\n\n");
  const text =
    `This business: "${ws.name}" (${ws.vertical}). Below are REVIEWS of its direct competitors.\n` +
    (summaries.length ? `\nAI SUMMARIES OF EACH RIVAL'S REVIEWS (Google/Gemini):\n${summaries.join("\n")}\n` : "") +
    (reviewBlock ? `\nINDIVIDUAL RIVAL REVIEWS (grouped by rival):\n${reviewBlock}\n` : "") +
    `\nFind the recurring complaints (openings for us) and praise (bars to match).`;

  try {
    const call = () => getLlm().callStructured<{ gaps: any[]; strengths: any[]; summary: string }>({ system: SYSTEM, text, schema: SCHEMA, tier: "extract", maxTokens: 2600 });
    const { data } = await call().catch(() => call());
    const gaps: RivalGap[] = (Array.isArray(data.gaps) ? data.gaps : [])
      .map((g) => ({ theme: clean(g.theme), rivals: (Array.isArray(g.rivals) ? g.rivals : []).map(clean).filter(Boolean).slice(0, 5), evidence: clean(g.evidence), angle: clean(g.angle) }))
      .filter((g) => g.theme && g.angle).slice(0, 5);
    const strengths: RivalStrength[] = (Array.isArray(data.strengths) ? data.strengths : [])
      .map((s) => ({ theme: clean(s.theme), rivals: (Array.isArray(s.rivals) ? s.rivals : []).map(clean).filter(Boolean).slice(0, 5) }))
      .filter((s) => s.theme).slice(0, 4);
    if (!gaps.length && !strengths.length) return empty(at);
    return { gaps, strengths, summary: clean(data.summary), rivalsRead, at };
  } catch {
    return empty(at, true);
  }
}

export function rivalReviewsIsGood(r: RivalReviewMining): boolean {
  if (r.failed) return false;
  return !!(r.gaps.length || r.strengths.length || r.empty);
}

export function getOrMakeRivalReviews(ws: WorkspaceRow, maxAgeHours = 24): Promise<RivalReviewMining> {
  return staleCached(ws, "rivalReviews", maxAgeHours, () => generateRivalReviews(ws), { isValid: (c) => !c.failed });
}
