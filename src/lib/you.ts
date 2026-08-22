import { createClient, createServiceClient, type RlsClient } from "@/lib/supabase/server";
import { buildWorkspaceReport } from "@/lib/report";
import { workspaceBusinessIds, type WorkspaceRow } from "@/lib/workspace";
import { staleCached } from "@/lib/staleCache";
import { getLlm, isLlmConfigured } from "@/lib/extraction/llm";

/**
 * The "You" pillar — answers the owner's first question: *how am I doing?* — from
 * data we already have. Three deterministic scorecards (reputation vs market,
 * price position, where you're findable) plus an LLM read of the owner's OWN
 * reviews (what customers love, what to fix, which reviews to answer). Cached on
 * the workspace (goals.you) like the briefing so the page stays fast.
 */

const RATING_RE = /Rated\s+([\d.]+)\s*★.*?from\s+([\d,]+)\s+review/i;

export interface ReviewVelocity {
  reviewsAdded: number;   // new reviews since the earliest snapshot in-window
  perWeek: number;        // reviewsAdded normalized to a weekly rate
  windowDays: number;     // span the trend is measured over
  ratingDelta: number | null; // rating change over the same window
}
export interface YouReputation {
  rating: number | null;
  reviewCount: number | null;
  sources: { source: string; rating: number; reviewCount: number | null }[];
  marketAvg: number | null;      // avg competitor rating
  delta: number | null;          // you − market
  rank: number | null;           // your position by rating among the market (1 = best)
  total: number;                 // businesses with a rating (you + rivals)
  /** every rated business (you + rivals), best-first — powers the rank dot-plot. */
  peers: { name: string; rating: number; isTarget: boolean }[];
  /** review velocity + rating trend from captured daily snapshots (null until we
   *  have ≥2 snapshots spanning ≥1 day). */
  velocity: ReviewVelocity | null;
  /** true once we've started capturing snapshots (so the UI can say "tracking"). */
  tracking: boolean;
}

/** One captured point in workspace.goals.repHistory (self-contained, no table). */
interface RepPoint { d: string; source: string; rating: number | null; count: number }
export interface YouPrice {
  avg: number | null;
  marketAvg: number | null;
  position: "higher" | "lower" | "similar" | null;
  deltaPct: number | null;
}
export interface YouDiscoverability {
  present: { platform: string; url?: string }[];
  missing: string[];
  scorePct: number;
}
export interface ReviewToAnswer { quote: string; why: string; reply: string; url?: string; reviewName?: string }
export interface YouSynthesis {
  headline: string;
  health: "strong" | "watch" | "at_risk";
  loves: string[];
  gripes: { theme: string; fix: string }[];
  reviewsToAnswer: ReviewToAnswer[];
  summary: string;
  /** true when the AI synthesis errored (e.g. API down / out of credits) — as
   *  opposed to genuinely having no reviews. Never cache-accepted, so it retries. */
  failed?: boolean;
}
export interface YouReport {
  name: string;
  reputation: YouReputation;
  price: YouPrice;
  discoverability: YouDiscoverability;
  synthesis: YouSynthesis;
  reviewsAnalyzed: number;
  /** true when Google's Gemini full-corpus review summary fed the synthesis —
   *  drives the required "Summarized with Gemini" attribution in the UI. */
  usedGoogleSummary?: boolean;
  at: string;
}

// Platforms a complete local business should be findable on. Base + per-vertical.
function expectedPlatforms(vertical: string): string[] {
  const base = ["website", "google", "yelp", "instagram", "facebook"];
  if (vertical === "salon") return [...base, "booking", "tiktok"];
  if (vertical === "restaurant" || vertical === "grocery") return [...base, "doordash", "ubereats"];
  return [...base, "tiktok"];
}
const PLATFORM_LABEL: Record<string, string> = {
  website: "Website", google: "Google", yelp: "Yelp", instagram: "Instagram",
  facebook: "Facebook", tiktok: "TikTok", youtube: "YouTube", booking: "Online booking",
  doordash: "DoorDash", ubereats: "Uber Eats", twitter: "X / Twitter",
};
export const platformLabel = (p: string) => PLATFORM_LABEL[p] ?? p;

// Trim a model artifact/tool-call bleed from a string field.
function strip(s?: string): string {
  const v = String(s ?? "");
  const i = v.search(/<\/|<(parameter|function|antml|invoke)\b/i);
  return (i >= 0 ? v.slice(0, i) : v).replace(/\s+/g, " ").trim();
}

const SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    headline: { type: "string", description: "≤10 words, plain English — the honest one-line read on their reputation." },
    summary: { type: "string", description: "2–3 plain sentences: your reputation standing and the single most useful thing to do about it." },
    health: { type: "string", enum: ["strong", "watch", "at_risk"], description: "strong = clearly well-reviewed; watch = mixed/some recurring gripes; at_risk = notable unhappy customers." },
    loves: { type: "array", items: { type: "string" }, description: "3–5 concrete things customers repeatedly praise (dish, service, value…). Short phrases.", maxItems: 5 },
    gripes: {
      type: "array", maxItems: 4,
      items: {
        type: "object", additionalProperties: false,
        properties: { theme: { type: "string", description: "the recurring complaint" }, fix: { type: "string", description: "one concrete action the owner can take" } },
        required: ["theme", "fix"],
      },
    },
    reviewsToAnswer: {
      type: "array", maxItems: 3, description: "The most worth-responding-to reviews (prioritize unhappy/at-risk). Use ONLY the reviews given.",
      items: {
        type: "object", additionalProperties: false,
        properties: {
          sourceIndex: { type: "integer", description: "the [n] index of the review from the list" },
          quote: { type: "string", description: "a short quote from that review, ≤160 chars" },
          why: { type: "string", description: "why it's worth answering, ≤12 words" },
          reply: { type: "string", description: "a warm, specific 1–2 sentence reply the owner could post" },
        },
        required: ["sourceIndex", "quote", "why", "reply"],
      },
    },
  },
  required: ["headline", "summary", "health", "loves", "gripes", "reviewsToAnswer"],
};

const SYSTEM =
  "You are Ask Rani, telling a busy, non-technical local-business owner how their reputation looks. Work ONLY from the reviews and numbers given — never invent praise or complaints. Be honest but constructive; the owner is \"you\". Plain language, no jargon.";

const emptySynthesis = (msg: string, failed = false): YouSynthesis => ({
  headline: "Your reputation at a glance", health: "watch", loves: [], gripes: [], reviewsToAnswer: [], summary: msg, failed,
});

export async function generateYou(ws: WorkspaceRow, db?: RlsClient): Promise<YouReport> {
  const at = new Date().toISOString();
  const supabase = db ?? (await createClient());
  const ids = await workspaceBusinessIds(ws, supabase);
  const report = await buildWorkspaceReport(ws, 30, supabase);

  const youRep = report.reputation.find((r) => r.isTarget);
  const rivalRatings = report.reputation.filter((r) => !r.isTarget && r.rating != null).map((r) => r.rating as number);
  const marketAvg = rivalRatings.length ? Number((rivalRatings.reduce((a, b) => a + b, 0) / rivalRatings.length).toFixed(2)) : null;
  const rated = report.reputation.filter((r) => r.rating != null).sort((a, b) => (b.rating as number) - (a.rating as number));
  const rank = youRep?.rating != null ? rated.findIndex((r) => r.isTarget) + 1 : null;
  // ── review velocity + rating trend from captured daily snapshots ──
  // History lives in workspace.goals.repHistory (self-contained; no extra table).
  // We measure the primary source (most-reviewed) from the oldest snapshot we
  // have to the current reading, then append today's point so it accrues.
  const primarySource = youRep?.sources?.[0]?.source ?? "google";
  const today = new Date().toISOString().slice(0, 10);
  const curCount = youRep?.reviewCount ?? null;
  const curRating = youRep?.rating ?? null;
  const { data: gRow } = await supabase.from("workspace").select("goals").eq("id", ws.id).maybeSingle();
  const history: RepPoint[] = (((gRow?.goals as any)?.repHistory as RepPoint[]) ?? []).filter(
    (h) => h && h.source === primarySource && typeof h.count === "number" && h.d < today,
  );
  let velocity: ReviewVelocity | null = null;
  if (curCount != null && history.length) {
    const oldest = history.reduce((a, b) => (a.d <= b.d ? a : b));
    const days = (Date.parse(today) - Date.parse(oldest.d)) / 86_400_000;
    if (days >= 1 && curCount >= oldest.count) {
      const reviewsAdded = curCount - oldest.count;
      velocity = {
        reviewsAdded,
        perWeek: Number(((reviewsAdded / days) * 7).toFixed(1)),
        windowDays: Math.round(days),
        ratingDelta: curRating != null && oldest.rating != null ? Number((curRating - oldest.rating).toFixed(2)) : null,
      };
    }
  }

  const reputation: YouReputation = {
    rating: youRep?.rating ?? null,
    reviewCount: youRep?.reviewCount ?? null,
    sources: youRep?.sources ?? [],
    marketAvg,
    delta: youRep?.rating != null && marketAvg != null ? Number((youRep.rating - marketAvg).toFixed(2)) : null,
    rank: rank && rank > 0 ? rank : null,
    total: rated.length,
    peers: rated.map((r) => ({ name: r.name, rating: r.rating as number, isTarget: r.isTarget })),
    velocity,
    tracking: curCount != null,
  };

  // Append today's snapshot (dedup per source+day, keep ~120 days) so the trend
  // fills in over time. Service client — goals isn't member-writable via RLS.
  if (curCount != null) {
    const svc0 = createServiceClient();
    const { data: cur0 } = await svc0.from("workspace").select("goals").eq("id", ws.id).maybeSingle();
    const prev: RepPoint[] = (((cur0?.goals as any)?.repHistory as RepPoint[]) ?? []).filter((h) => !(h.source === primarySource && h.d === today));
    const next = [...prev, { d: today, source: primarySource, rating: curRating, count: curCount }].slice(-120);
    await svc0.from("workspace").update({ goals: { ...((cur0?.goals as object) ?? {}), repHistory: next } }).eq("id", ws.id);
  }

  const youPrice = report.pricing.find((p) => p.isTarget)?.avgPrice ?? null;
  const rivalPrices = report.pricing.filter((p) => !p.isTarget && p.avgPrice != null).map((p) => p.avgPrice as number);
  const priceMarket = rivalPrices.length ? Number((rivalPrices.reduce((a, b) => a + b, 0) / rivalPrices.length).toFixed(2)) : null;
  let position: YouPrice["position"] = null;
  let deltaPct: number | null = null;
  if (youPrice != null && priceMarket != null && priceMarket > 0) {
    deltaPct = Number((((youPrice - priceMarket) / priceMarket) * 100).toFixed(0));
    position = deltaPct > 5 ? "higher" : deltaPct < -5 ? "lower" : "similar";
  }
  const price: YouPrice = { avg: youPrice, marketAvg: priceMarket, position, deltaPct };

  // discoverability — where the owner is findable (identities + review sources)
  let present: { platform: string; url?: string }[] = [];
  if (ids.targetId) {
    const { data: idents } = await supabase.from("external_identity").select("platform, url").eq("business_id", ids.targetId);
    const byPlat = new Map<string, string | undefined>();
    for (const r of idents ?? []) if (!byPlat.has((r as any).platform)) byPlat.set((r as any).platform, (r as any).url);
    // a rating from a source proves presence even without a stored identity row
    for (const s of reputation.sources) if (!byPlat.has(s.source)) byPlat.set(s.source, undefined);
    present = [...byPlat.entries()].map(([platform, url]) => ({ platform, url }));
  }
  const presentSet = new Set(present.map((p) => p.platform));
  const expected = expectedPlatforms(ws.vertical ?? "restaurant");
  const missing = expected.filter((p) => !presentSet.has(p));
  const scorePct = Math.round(((expected.length - missing.length) / expected.length) * 100);
  const discoverability: YouDiscoverability = { present, missing, scorePct };

  // ── own reviews → love/gripe/answer synthesis ──
  let reviews: { text: string; url?: string; at?: string; name?: string }[] = [];
  if (ids.targetId) {
    const { data: rows } = await supabase
      .from("content_item")
      .select("text, url, published_at, observed_at, external_ref")
      .eq("business_id", ids.targetId)
      .in("platform", ["google", "yelp"])
      .order("published_at", { ascending: false, nullsFirst: false })
      .limit(80);
    reviews = (rows ?? [])
      // external_ref is the GBP review name (accounts/…/reviews/…) when synced via
      // the owner connection — carry it so a reply can be posted straight to Google.
      .map((r) => ({ text: String((r as any).text ?? "").replace(/\s+/g, " ").trim(), url: (r as any).url ?? undefined, at: (r as any).published_at ?? undefined, name: /\/reviews\//.test(String((r as any).external_ref ?? "")) ? String((r as any).external_ref) : undefined }))
      .filter((r) => r.text.length > 15 && !RATING_RE.test(r.text)) // drop the aggregate "Rated X★…" summaries
      .slice(0, 40);
  }

  // Google's Gemini full-corpus review summary (Places API reviewSummary) — breadth
  // the ≈5 raw reviews can't give. We fuse it in so synthesis reflects ALL reviews.
  let googleSummary = "";
  if (ids.targetId) {
    const { data: bizRow } = await supabase.from("business").select("attributes").eq("id", ids.targetId).maybeSingle();
    googleSummary = String((bizRow?.attributes as any)?.googleReviewSummary?.text ?? "").replace(/\s+/g, " ").trim();
  }
  const usedGoogleSummary = !!googleSummary;

  let synthesis: YouSynthesis;
  if (!isLlmConfigured()) {
    synthesis = emptySynthesis("Connect an AI key to read what your customers are saying.");
  } else if (!reviews.length && !googleSummary) {
    synthesis = emptySynthesis("No review text captured yet — after the next scan we'll read what customers are saying and pull out what they love and what to fix.");
  } else {
    const numbered = reviews.map((r, i) => `[${i}] ${r.text.slice(0, 300)}`).join("\n");
    const corpus = googleSummary ? `AI summary of ALL your reviews (Google/Gemini, full corpus):\n${googleSummary}\n\n` : "";
    try {
      const call = () => getLlm().callStructured<{
        headline: string;
        health: YouSynthesis["health"];
        loves: string[];
        gripes: { theme: string; fix: string }[];
        reviewsToAnswer: { sourceIndex: number; quote: string; why: string; reply: string }[];
        summary: string;
      }>({
        system: SYSTEM,
        text: `Your rating: ${reputation.rating ?? "?"}★ from ${reputation.reviewCount ?? "?"} reviews (market avg ${reputation.marketAvg ?? "?"}★).\n\n${corpus}${numbered ? `Recent individual reviews:\n${numbered}\n\n` : ""}Write the reputation read${googleSummary ? ", weighting the full-corpus summary for breadth and the individual reviews for specific quotes to answer" : ""}.`,
        schema: SCHEMA,
        tier: "extract",
        maxTokens: 1300,
      });
      // one retry on transient failure before we give up
      const { data } = await call().catch(() => call());
      synthesis = {
        headline: strip(data.headline) || "Your reputation at a glance",
        health: data.health ?? "watch",
        loves: (data.loves ?? []).map(strip).filter(Boolean).slice(0, 5),
        gripes: (data.gripes ?? []).map((g) => ({ theme: strip(g.theme), fix: strip(g.fix) })).filter((g) => g.theme).slice(0, 4),
        reviewsToAnswer: (data.reviewsToAnswer ?? [])
          .map((r) => ({ quote: strip(r.quote), why: strip(r.why), reply: strip(r.reply), url: reviews[r.sourceIndex]?.url, reviewName: reviews[r.sourceIndex]?.name }))
          .filter((r) => r.quote && r.reply)
          .slice(0, 3),
        summary: strip(data.summary),
      };
      // Deterministic fallback so the hero band is never blank if the model
      // starved the summary field.
      if (!synthesis.summary && reputation.rating != null) {
        const vs = reputation.delta == null ? "" :
          reputation.delta >= 0 ? ` — above the local ${reputation.marketAvg}★ average` : ` — below the local ${reputation.marketAvg}★ average`;
        const fix = synthesis.gripes[0]?.theme;
        synthesis.summary = `You're at ${reputation.rating}★ from ${reputation.reviewCount ?? "many"} reviews${vs}.${fix ? ` The clearest thing to work on: ${fix.toLowerCase()}.` : ""}`;
      }
    } catch {
      // The AI read FAILED (API error / out of credits) — we DO have reviews.
      // Don't pretend there are none, and mark it failed so it's never cached as
      // final (getOrMakeYou/youIsGood retry it next time instead of sticking).
      const vs = reputation.delta == null ? "" : reputation.delta >= 0 ? ` — above the local ${reputation.marketAvg}★ average` : ` — below the local ${reputation.marketAvg}★ average`;
      synthesis = emptySynthesis(
        reputation.rating != null
          ? `You're at ${reputation.rating}★ from ${reputation.reviewCount ?? "many"} reviews${vs}. We couldn't read your ${reviews.length} recent reviews just now — we'll pull out the highlights on the next refresh.`
          : "We couldn't read your reviews just now — we'll try again on the next refresh.",
        true,
      );
    }
  }

  return {
    name: youRep?.name ?? ws.name,
    reputation, price, discoverability, synthesis,
    reviewsAnalyzed: reviews.length,
    usedGoogleSummary,
    at,
  };
}

/** Non-empty when the synthesis actually said something (warm-retry predicate).
 *  A failed AI read is never "good" — so warm/getOrMakeYou retry it. */
export function youIsGood(y: YouReport): boolean {
  if (y.synthesis.failed) return false;
  return !!(y.synthesis.summary && (y.synthesis.loves.length || y.synthesis.gripes.length || y.reviewsAnalyzed === 0));
}

/** Cached You report — served instantly, regenerated in the background when stale
 *  (never blocks a page render on the AI read). A failed read self-heals on the
 *  next view since it isn't treated as valid. */
export function getOrMakeYou(ws: WorkspaceRow, maxAgeHours = 12): Promise<YouReport> {
  return staleCached(ws, "you", maxAgeHours, () => generateYou(ws), {
    isValid: (c) => !!c.synthesis && !c.synthesis.failed,
  });
}
