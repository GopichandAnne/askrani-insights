import type { PipelineOffer } from "../extraction/pipeline";

/**
 * Recommendation & decision engine — guide Section 10.
 *
 * Transparent heuristic baseline (10.2): priority = expected_impact ×
 * confidence × urgency × strategic_fit ÷ max(effort, min_effort). No causal
 * claims, no guaranteed revenue (10.4 guardrails). Every recommendation carries
 * why_now bullets and the evidence it was derived from.
 *
 * This baseline is deliberately rule-based so the first version is auditable;
 * expected_impact graduates to comparable historical outcomes once the outcome
 * loop has data (10.2).
 */

export interface BusinessOffers {
  businessId: string;
  name: string;
  offers: PipelineOffer[];
  rating?: number | null; // latest observed review rating (0–5), if any
  reviewCount?: number | null; // review volume behind that rating
}

export interface Recommendation {
  category: "promotion" | "content" | "pricing" | "menu" | "reputation" | "operations" | "channel" | "experiment";
  title: string;
  action: string;
  why_now: string[];
  evidence: string[]; // human-readable evidence pointers (entity/business)
  expected_impact: { metric: string; range_pct: [number, number]; confidence: number };
  effort: "low" | "medium" | "high";
  urgency: "this_week" | "this_month" | "watch";
  priority: number;
}

const EFFORT_WEIGHT = { low: 1, medium: 2, high: 3 } as const;
const URGENCY_WEIGHT = { this_week: 1, this_month: 0.7, watch: 0.4 } as const;
const MIN_EFFORT = 1;

function score(r: Omit<Recommendation, "priority">): number {
  const impact = (r.expected_impact.range_pct[0] + r.expected_impact.range_pct[1]) / 2;
  const strategicFit = 1; // pluggable per workspace goals (guide 10.2)
  const priority =
    (impact * r.expected_impact.confidence * URGENCY_WEIGHT[r.urgency] * strategicFit) /
    Math.max(EFFORT_WEIGHT[r.effort], MIN_EFFORT);
  return Number(priority.toFixed(3));
}

const PROMO_TYPES = new Set(["sale", "combo", "happy_hour", "prix_fixe", "buffet", "multi_buy", "bogo"]);

function isLunch(o: PipelineOffer) {
  return /lunch/i.test(o.entity_text) || (o.pricing as any)?.meal_period === "lunch";
}

/**
 * Compare the target business against its competitor set and emit prioritized,
 * evidence-bound recommendations. Pure function — easy to test and to reason
 * about (guide 10.4: distinguish observation, interpretation, recommendation).
 */
export function generateRecommendations(
  target: BusinessOffers,
  competitors: BusinessOffers[],
  vertical: string = "restaurant",
): Recommendation[] {
  const recs: Omit<Recommendation, "priority">[] = [];
  const peerCount = Math.max(1, competitors.length);
  const isGrocery = vertical === "grocery";
  const isSalon = vertical === "salon";

  // 1) Weekday-lunch daypart gap — restaurant-only (guide 10.3 canonical example).
  const peersWithLunch = competitors.filter((c) => c.offers.some(isLunch)).length;
  const targetHasLunch = target.offers.some(isLunch);
  if (vertical === "restaurant" && !targetHasLunch && peersWithLunch >= Math.ceil(peerCount / 2)) {
    recs.push({
      category: "promotion",
      title: "Own the weekday lunch gap",
      action: "Test a Monday–Thursday lunch special for two weeks and measure weekday orders.",
      why_now: [
        `${peersWithLunch} of ${peerCount} peers promote a lunch special; you don't.`,
        "A defined weekday daypart is a low-effort way to capture existing demand.",
      ],
      evidence: competitors.filter((c) => c.offers.some(isLunch)).map((c) => `${c.name}: lunch offer observed`),
      expected_impact: { metric: "weekday_orders", range_pct: [5, 12], confidence: 0.55 },
      effort: "medium",
      urgency: "this_week",
    });
  }

  // 2) Promotion saturation / cadence gap (guide 7.3 insight: promotion saturation).
  const peerPromoShare =
    competitors.filter((c) => c.offers.some((o) => PROMO_TYPES.has(o.offer_type))).length / peerCount;
  const targetPromos = target.offers.filter((o) => PROMO_TYPES.has(o.offer_type)).length;
  if (peerPromoShare >= 0.5 && targetPromos === 0) {
    recs.push({
      category: "content",
      title: "You're quiet while peers are promoting",
      action: "Publish at least one clearly-priced offer this week; peers are actively running promotions.",
      why_now: [
        `${Math.round(peerPromoShare * 100)}% of tracked peers are currently running a visible promotion.`,
        "Silence during a promotion-heavy period cedes share of attention.",
      ],
      evidence: competitors
        .filter((c) => c.offers.some((o) => PROMO_TYPES.has(o.offer_type)))
        .slice(0, 5)
        .map((c) => `${c.name}: ${c.offers.find((o) => PROMO_TYPES.has(o.offer_type))?.entity_text}`),
      expected_impact: { metric: "engagement", range_pct: [4, 10], confidence: 0.5 },
      effort: "low",
      urgency: "this_week",
    });
  }

  // 3) Price positioning (guide 10.4: no price-matching without margin — value differentiation).
  const priced = (b: BusinessOffers) =>
    b.offers.map((o) => (o.pricing as any)?.amount).filter((n): n is number => typeof n === "number");
  const targetAvg = avg(priced(target));
  const peerAvgs = competitors.map((c) => avg(priced(c))).filter((n) => n > 0);
  const peerAvg = avg(peerAvgs);
  if (targetAvg > 0 && peerAvg > 0 && targetAvg > peerAvg * 1.15) {
    recs.push({
      category: "pricing",
      title: "Your visible prices sit above the local set",
      action:
        "Don't cut price blindly — add a value bundle or highlight portion/quality so the premium reads as justified.",
      why_now: [
        `Your observed average priced item (~$${targetAvg.toFixed(2)}) is >15% above the peer average (~$${peerAvg.toFixed(2)}).`,
        "Value differentiation protects margin better than price matching (needs margin data to confirm).",
      ],
      evidence: [`${competitors.length} peers priced`, `target avg $${targetAvg.toFixed(2)}`],
      expected_impact: { metric: "conversion", range_pct: [2, 6], confidence: 0.4 },
      effort: "medium",
      urgency: "this_month",
    });
  }

  // 4) Menu gap — dishes peers feature that the target doesn't (guide 7.3 menu gap).
  const targetDishes = new Set(target.offers.map((o) => normalize(o.entity_text)));
  const peerDishCounts = new Map<string, { count: number; example: string }>();
  for (const c of competitors) {
    const seen = new Set<string>();
    for (const o of c.offers) {
      const key = normalize(o.entity_text);
      if (!key || seen.has(key)) continue;
      seen.add(key);
      const cur = peerDishCounts.get(key) ?? { count: 0, example: o.entity_text };
      cur.count++;
      peerDishCounts.set(key, cur);
    }
  }
  const gaps = [...peerDishCounts.entries()]
    .filter(([key, v]) => v.count >= Math.ceil(peerCount / 2) && !targetDishes.has(key))
    .sort((a, b) => b[1].count - a[1].count)
    .slice(0, 3);
  if (gaps.length) {
    const where = isGrocery ? "peer stores stock" : isSalon ? "peer service menus" : "peer menus";
    const title = isGrocery
      ? "Popular products your rivals carry that you don't"
      : isSalon
        ? "Treatments rivals offer that you don't feature"
        : "Popular local dishes missing from your menu";
    const verb = isGrocery ? "stocking" : isSalon ? "adding or promoting" : "adding or featuring";
    const metric = isGrocery ? "basket_coverage" : isSalon ? "service_coverage" : "menu_coverage";
    recs.push({
      category: "menu",
      title,
      action: `Evaluate ${verb}: ${gaps.map(([, v]) => v.example).join(", ")}.`,
      why_now: gaps.map(([, v]) => `${v.example} appears on ${v.count} of ${peerCount} ${where}.`),
      evidence: gaps.map(([, v]) => `${v.example} (${v.count} peers)`),
      expected_impact: { metric, range_pct: [3, 8], confidence: 0.45 },
      effort: "high",
      urgency: "this_month",
    });
  }

  // 5) Grocery: rivals discounting staples you carry at full price (§7.2:
  //    overlapping discounted products / loss-leader awareness).
  if (isGrocery) {
    const targetFull = new Set(
      target.offers.filter((o) => !PROMO_TYPES.has(o.offer_type)).map((o) => normalize(o.entity_text)),
    );
    const discounted = new Map<string, { count: number; example: string }>();
    for (const c of competitors) {
      const seen = new Set<string>();
      for (const o of c.offers) {
        if (!PROMO_TYPES.has(o.offer_type)) continue;
        const key = normalize(o.entity_text);
        if (!key || seen.has(key) || !targetFull.has(key)) continue;
        seen.add(key);
        const cur = discounted.get(key) ?? { count: 0, example: o.entity_text };
        cur.count++;
        discounted.set(key, cur);
      }
    }
    const hot = [...discounted.entries()].sort((a, b) => b[1].count - a[1].count).slice(0, 3);
    if (hot.length) {
      recs.push({
        category: "promotion",
        title: "Rivals are discounting staples you sell at full price",
        action: `Consider a promotion or price-check on: ${hot.map(([, v]) => v.example).join(", ")} — shoppers comparison-shop these.`,
        why_now: hot.map(([, v]) => `${v.example} is on promotion at ${v.count} of ${peerCount} nearby stores; you list it at regular price.`),
        evidence: hot.map(([, v]) => `${v.example} discounted by ${v.count} peers`),
        expected_impact: { metric: "basket_traffic", range_pct: [3, 9], confidence: 0.5 },
        effort: "medium",
        urgency: "this_week",
      });
    }
  }

  // 6) Reputation gap — higher-rated rivals nearby (guide 7.3 reputation; works
  //    from review ratings alone, so it fires even when peers publish no menu).
  if (typeof target.rating === "number" && target.rating > 0) {
    const better = competitors.filter(
      (c) => typeof c.rating === "number" && (c.rating as number) >= target.rating! + 0.3,
    );
    if (better.length >= 2) {
      const top = [...better].sort((a, b) => (b.rating as number) - (a.rating as number)).slice(0, 3);
      recs.push({
        category: "reputation",
        title: "Higher-rated rivals are nearby",
        action:
          "Close the review gap: ask happy customers for a review, respond to recent critical ones, and study what the top-rated peers are praised for.",
        why_now: [
          `${better.length} nearby peers are rated ≥0.3★ above you (you: ${target.rating.toFixed(1)}★).`,
          `Top local ratings: ${top.map((c) => `${c.name} ${(c.rating as number).toFixed(1)}★`).join(", ")}.`,
        ],
        evidence: top.map(
          (c) => `${c.name}: ${(c.rating as number).toFixed(1)}★${c.reviewCount ? ` (${c.reviewCount} reviews)` : ""}`,
        ),
        expected_impact: { metric: "rating_and_conversion", range_pct: [2, 6], confidence: 0.45 },
        effort: "medium",
        urgency: "this_month",
      });
    }
  }

  return recs
    .map((r) => ({ ...r, priority: score(r) }))
    .sort((a, b) => b.priority - a.priority);
}

function avg(ns: number[]): number {
  return ns.length ? ns.reduce((a, b) => a + b, 0) / ns.length : 0;
}
function normalize(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9 ]/g, "").replace(/\s+/g, " ").trim();
}
