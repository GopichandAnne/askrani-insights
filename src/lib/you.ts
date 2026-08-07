import { createClient, createServiceClient, type RlsClient } from "@/lib/supabase/server";
import { buildWorkspaceReport } from "@/lib/report";
import { workspaceBusinessIds, type WorkspaceRow } from "@/lib/workspace";
import { getLlm, isLlmConfigured } from "@/lib/extraction/llm";

/**
 * The "You" pillar — answers the owner's first question: *how am I doing?* — from
 * data we already have. Three deterministic scorecards (reputation vs market,
 * price position, where you're findable) plus an LLM read of the owner's OWN
 * reviews (what customers love, what to fix, which reviews to answer). Cached on
 * the workspace (goals.you) like the briefing so the page stays fast.
 */

const RATING_RE = /Rated\s+([\d.]+)\s*★.*?from\s+([\d,]+)\s+review/i;

export interface YouReputation {
  rating: number | null;
  reviewCount: number | null;
  sources: { source: string; rating: number; reviewCount: number | null }[];
  marketAvg: number | null;      // avg competitor rating
  delta: number | null;          // you − market
  rank: number | null;           // your position by rating among the market (1 = best)
  total: number;                 // businesses with a rating (you + rivals)
}
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
export interface ReviewToAnswer { quote: string; why: string; reply: string; url?: string }
export interface YouSynthesis {
  headline: string;
  health: "strong" | "watch" | "at_risk";
  loves: string[];
  gripes: { theme: string; fix: string }[];
  reviewsToAnswer: ReviewToAnswer[];
  summary: string;
}
export interface YouReport {
  name: string;
  reputation: YouReputation;
  price: YouPrice;
  discoverability: YouDiscoverability;
  synthesis: YouSynthesis;
  reviewsAnalyzed: number;
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

const emptySynthesis = (msg: string): YouSynthesis => ({
  headline: "Your reputation at a glance", health: "watch", loves: [], gripes: [], reviewsToAnswer: [], summary: msg,
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
  const reputation: YouReputation = {
    rating: youRep?.rating ?? null,
    reviewCount: youRep?.reviewCount ?? null,
    sources: youRep?.sources ?? [],
    marketAvg,
    delta: youRep?.rating != null && marketAvg != null ? Number((youRep.rating - marketAvg).toFixed(2)) : null,
    rank: rank && rank > 0 ? rank : null,
    total: rated.length,
  };

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
  let reviews: { text: string; url?: string; at?: string }[] = [];
  if (ids.targetId) {
    const { data: rows } = await supabase
      .from("content_item")
      .select("text, url, published_at, observed_at")
      .eq("business_id", ids.targetId)
      .in("platform", ["google", "yelp"])
      .order("published_at", { ascending: false, nullsFirst: false })
      .limit(80);
    reviews = (rows ?? [])
      .map((r) => ({ text: String((r as any).text ?? "").replace(/\s+/g, " ").trim(), url: (r as any).url ?? undefined, at: (r as any).published_at ?? undefined }))
      .filter((r) => r.text.length > 15 && !RATING_RE.test(r.text)) // drop the aggregate "Rated X★…" summaries
      .slice(0, 40);
  }

  let synthesis: YouSynthesis;
  if (!isLlmConfigured()) {
    synthesis = emptySynthesis("Connect an AI key to read what your customers are saying.");
  } else if (!reviews.length) {
    synthesis = emptySynthesis("No review text captured yet — after the next scan we'll read what customers are saying and pull out what they love and what to fix.");
  } else {
    const numbered = reviews.map((r, i) => `[${i}] ${r.text.slice(0, 300)}`).join("\n");
    try {
      const { data } = await getLlm().callStructured<{
        headline: string;
        health: YouSynthesis["health"];
        loves: string[];
        gripes: { theme: string; fix: string }[];
        reviewsToAnswer: { sourceIndex: number; quote: string; why: string; reply: string }[];
        summary: string;
      }>({
        system: SYSTEM,
        text: `Your rating: ${reputation.rating ?? "?"}★ from ${reputation.reviewCount ?? "?"} reviews (market avg ${reputation.marketAvg ?? "?"}★).\n\nYour recent reviews:\n${numbered}\n\nWrite the reputation read.`,
        schema: SCHEMA,
        tier: "extract",
        maxTokens: 1300,
      });
      synthesis = {
        headline: strip(data.headline) || "Your reputation at a glance",
        health: data.health ?? "watch",
        loves: (data.loves ?? []).map(strip).filter(Boolean).slice(0, 5),
        gripes: (data.gripes ?? []).map((g) => ({ theme: strip(g.theme), fix: strip(g.fix) })).filter((g) => g.theme).slice(0, 4),
        reviewsToAnswer: (data.reviewsToAnswer ?? [])
          .map((r) => ({ quote: strip(r.quote), why: strip(r.why), reply: strip(r.reply), url: reviews[r.sourceIndex]?.url }))
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
      synthesis = emptySynthesis("We're still gathering enough reviews to summarize — check back after the next scan.");
    }
  }

  return {
    name: youRep?.name ?? ws.name,
    reputation, price, discoverability, synthesis,
    reviewsAnalyzed: reviews.length,
    at,
  };
}

/** Non-empty when the synthesis actually said something (warm-retry predicate). */
export function youIsGood(y: YouReport): boolean {
  return !!(y.synthesis.summary && (y.synthesis.loves.length || y.synthesis.gripes.length || y.reviewsAnalyzed === 0));
}

/** Cached You report, regenerated when older than maxAgeHours. */
export async function getOrMakeYou(ws: WorkspaceRow, maxAgeHours = 12): Promise<YouReport> {
  const supabase = await createClient();
  const { data } = await supabase.from("workspace").select("goals").eq("id", ws.id).maybeSingle();
  const cached = (data?.goals as any)?.you as YouReport | undefined;
  if (cached?.at && Date.now() - new Date(cached.at).getTime() < maxAgeHours * 3600_000 && cached.synthesis) return cached;

  const fresh = await generateYou(ws);
  const svc = createServiceClient();
  const { data: cur } = await svc.from("workspace").select("goals").eq("id", ws.id).maybeSingle();
  await svc.from("workspace").update({ goals: { ...((cur?.goals as any) ?? {}), you: fresh } }).eq("id", ws.id);
  return fresh;
}
