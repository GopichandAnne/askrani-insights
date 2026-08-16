import { staleCached } from "@/lib/staleCache";
import { createClient, createServiceClient, type RlsClient } from "@/lib/supabase/server";
import { getLlm, isLlmConfigured } from "@/lib/extraction/llm";
import { workspaceBusinessIds, type WorkspaceRow } from "@/lib/workspace";

/**
 * Review PULSE — the time-derivative of reputation. Ratings/counts (the free
 * heartbeat, from goals.repHistory) tell you SOMETHING moved; this tells you WHAT
 * is changing in what customers say: an emerging complaint, rising praise, or a
 * fading issue. Each cycle we extract the current review themes (grounded in the
 * raw reviews + Google's full-corpus summary) and diff them against the last
 * snapshot stored on goals.themeHistory — so the owner sees momentum, not just a
 * static list. Feeds the weekly digest (push) + the You page.
 *
 * Hardened like the other LLM pillars: a failed AI read is flagged (never cached
 * as final) so it self-heals on the next refresh.
 */

const RATING_RE = /Rated\s+([\d.]+)\s*★.*?from\s+([\d,]+)\s+review/i;
const clean = (s: unknown) => String(s ?? "").replace(/<\/?[a-z][^>]*>/gi, "").replace(/\s+/g, " ").trim();

export interface ThemeSnapshot { d: string; count: number | null; themes: { theme: string; sentiment: string; strength: number }[] }
export interface ReviewPulse {
  newReviews: number | null;   // since the last snapshot
  ratingDelta: number | null;
  windowDays: number | null;
  emerging: { theme: string; strength: number }[];   // negative, new or growing
  rising: string[];                                   // positive, new or growing
  fading: string[];                                   // dropped off since last time
  summary: string;
  at: string;
  empty?: boolean;
  failed?: boolean;
}

const SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    themes: {
      type: "array", description: "Current review themes, grounded ONLY in the reviews/summary given. 4–10 items.",
      items: {
        type: "object", additionalProperties: false,
        properties: {
          theme: { type: "string", description: "Short phrase, e.g. 'slow service', 'great biryani'." },
          sentiment: { type: "string", enum: ["positive", "negative", "mixed"] },
          strength: { type: "integer", description: "1 (minor mention) to 3 (dominant in reviews)." },
          trend: { type: "string", enum: ["new", "growing", "steady"], description: "vs the PREVIOUS themes list: new = not seen before, growing = stronger than before, steady = about the same." },
        },
        required: ["theme", "sentiment", "strength", "trend"],
      },
    },
    faded: { type: "array", items: { type: "string" }, description: "Previous themes that no longer appear in the current reviews." },
    summary: { type: "string", description: "1–2 plain sentences: what's CHANGING in the reviews (not a static description)." },
  },
  required: ["themes", "faded", "summary"],
};

const SYSTEM =
  "You track how a local business's reviews CHANGE over time. Given the previous themes and the current reviews, list the current themes with sentiment + whether each is new/growing/steady vs before, and which previous themes have faded. Ground everything ONLY in the reviews/summary provided — never invent. Plain language.";

const empty = (at: string, failed = false): ReviewPulse => ({ newReviews: null, ratingDelta: null, windowDays: null, emerging: [], rising: [], fading: [], summary: "", at, empty: true, ...(failed ? { failed: true } : {}) });

export async function generateReviewPulse(ws: WorkspaceRow, db?: RlsClient): Promise<ReviewPulse> {
  const at = new Date().toISOString();
  const supabase = db ?? (await createClient());
  const ids = await workspaceBusinessIds(ws, supabase);
  if (!ids.targetId) return empty(at);

  // heartbeat: new-review count + rating delta from goals (repHistory / you velocity)
  const { data: gRow } = await supabase.from("workspace").select("goals").eq("id", ws.id).maybeSingle();
  const goals = (gRow?.goals as Record<string, any>) ?? {};
  const vel = goals.you?.reputation?.velocity as { reviewsAdded?: number; windowDays?: number; ratingDelta?: number | null } | undefined;
  const prevSnap = (goals.themeHistory as ThemeSnapshot[] | undefined)?.slice(-1)[0];
  const prevThemes = prevSnap?.themes ?? [];

  // current reviews (raw) + Google full-corpus summary
  const [{ data: rows }, { data: bizRow }] = await Promise.all([
    supabase.from("content_item").select("text").eq("business_id", ids.targetId).in("platform", ["google", "yelp"]).order("published_at", { ascending: false, nullsFirst: false }).limit(40),
    supabase.from("business").select("attributes").eq("id", ids.targetId).maybeSingle(),
  ]);
  const reviewSnips = (rows ?? [])
    .map((r) => clean((r as any).text)).filter((t) => t.length > 15 && !RATING_RE.test(t)).slice(0, 30).map((t) => t.slice(0, 240));
  const gSummary = clean((bizRow?.attributes as any)?.googleReviewSummary?.text);
  const curCount = typeof goals.you?.reputation?.reviewCount === "number" ? goals.you.reputation.reviewCount : null;

  if (!reviewSnips.length && !gSummary) return empty(at);
  if (!isLlmConfigured()) return empty(at);

  const text =
    `Business: "${ws.name}" (${ws.vertical}).\n` +
    (typeof vel?.ratingDelta === "number" || typeof vel?.reviewsAdded === "number" ? `Heartbeat: ${vel?.reviewsAdded ?? "?"} new reviews, rating change ${vel?.ratingDelta ?? "?"} over ~${vel?.windowDays ?? "?"} days.\n` : "") +
    `\nPREVIOUS THEMES (last check): ${prevThemes.length ? prevThemes.map((t) => `${t.theme} [${t.sentiment}]`).join(", ") : "(none captured yet — first read)"}\n` +
    (gSummary ? `\nAI SUMMARY OF ALL REVIEWS (Google/Gemini):\n${gSummary}\n` : "") +
    (reviewSnips.length ? `\nRECENT REVIEWS:\n${reviewSnips.join("\n")}\n` : "") +
    `\nList current themes with trend vs the previous list, the faded themes, and what's changing.`;

  try {
    const call = () => getLlm().callStructured<{ themes: any[]; faded: any[]; summary: string }>({ system: SYSTEM, text, schema: SCHEMA, tier: "extract", maxTokens: 1100 });
    const { data } = await call().catch(() => call());
    const themes = (Array.isArray(data.themes) ? data.themes : [])
      .map((t) => ({ theme: clean(t.theme), sentiment: clean(t.sentiment) || "mixed", strength: Math.max(1, Math.min(3, Number(t.strength) || 1)), trend: clean(t.trend) || "steady" }))
      .filter((t) => t.theme);
    const emerging = themes.filter((t) => t.sentiment === "negative" && (t.trend === "new" || t.trend === "growing")).map((t) => ({ theme: t.theme, strength: t.strength })).slice(0, 4);
    const rising = themes.filter((t) => t.sentiment === "positive" && (t.trend === "new" || t.trend === "growing")).map((t) => t.theme).slice(0, 4);
    const fading = (Array.isArray(data.faded) ? data.faded : []).map(clean).filter(Boolean).slice(0, 4);

    // append the current snapshot so next cycle can diff against it
    const snap: ThemeSnapshot = { d: at.slice(0, 10), count: curCount, themes: themes.map((t) => ({ theme: t.theme, sentiment: t.sentiment, strength: t.strength })) };
    const history = [ ...((goals.themeHistory as ThemeSnapshot[] | undefined) ?? []).filter((h) => h.d !== snap.d), snap ].slice(-12);
    const svc = createServiceClient();
    const { data: cur } = await svc.from("workspace").select("goals").eq("id", ws.id).maybeSingle();
    await svc.from("workspace").update({ goals: { ...((cur?.goals as object) ?? {}), themeHistory: history } }).eq("id", ws.id).then(() => {}, () => {});

    return {
      newReviews: typeof vel?.reviewsAdded === "number" ? vel.reviewsAdded : null,
      ratingDelta: typeof vel?.ratingDelta === "number" ? vel.ratingDelta : null,
      windowDays: typeof vel?.windowDays === "number" ? vel.windowDays : null,
      emerging, rising, fading, summary: clean(data.summary), at,
    };
  } catch {
    return empty(at, true);
  }
}

export function pulseIsGood(p: ReviewPulse): boolean {
  if (p.failed) return false;
  return !!(p.summary || p.emerging.length || p.rising.length || p.empty);
}

export function getOrMakeReviewPulse(ws: WorkspaceRow, maxAgeHours = 12): Promise<ReviewPulse> {
  return staleCached(ws, "pulse", maxAgeHours, () => generateReviewPulse(ws), { isValid: (c) => !c.failed });
}
