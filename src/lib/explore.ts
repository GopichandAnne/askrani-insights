import { getProvider } from "@/lib/providers/registry";
import { structuredVertical, nameVertical, extractSubtype, subtypeLabel } from "@/lib/classify";
import { smartVertical } from "@/lib/detect";
import { getLlm, isLlmConfigured } from "@/lib/extraction/llm";

/**
 * "Explore an area" — a no-setup market scan. Enter a zip/city + what you're
 * looking for; we geocode the area, run a geo-biased Google Places search, keep
 * only results near that centroid (kills same-name results from other cities),
 * and rank by quality × popularity. Ratings/reviews come straight from the
 * search response, so this needs no collection and no workspace.
 */

export interface ExploreResult {
  name: string;
  rating: number | null;
  reviews: number | null;
  address?: string;
  website?: string;
  geo?: { lat: number; lng: number };
  vertical: string;
  subtype: string;
  distanceKm?: number;
  mapsUrl?: string;
  category?: string; // Google primaryType — seeds onboarding
  placeId?: string;
}
export interface ExploreResponse {
  center?: { lat: number; lng: number };
  areaLabel?: string;
  results: ExploreResult[];
  error?: string;
}

function haversineKm(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
  const R = 6371, toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat), dLng = toRad(b.lng - a.lng);
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}

/** Forward-geocode a zip/city to a centroid (Nominatim, free, US-biased). */
async function geocodeArea(q: string): Promise<{ lat: number; lng: number; label: string } | null> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 7000);
  try {
    const res = await fetch(
      `https://nominatim.openstreetmap.org/search?format=jsonv2&limit=1&countrycodes=us&q=${encodeURIComponent(q)}`,
      { headers: { "user-agent": "local-intel-app/0.1", "accept-language": "en" }, signal: ctrl.signal },
    );
    if (!res.ok) return null;
    const d = ((await res.json()) as any[])[0];
    if (!d) return null;
    return { lat: Number(d.lat), lng: Number(d.lon), label: shortLabel(d.display_name) };
  } catch {
    return null;
  } finally {
    clearTimeout(t);
  }
}
function shortLabel(display: string): string {
  // "78641, Leander, Williamson County, Texas, United States" → "Leander, Texas"
  const parts = String(display).split(",").map((s) => s.trim());
  const city = parts.find((p) => p && !/^\d+$/.test(p) && !/county/i.test(p) && !/united states/i.test(p));
  const state = parts.find((p) => /texas|california|new york|new jersey|florida|[A-Z]{2}$/i.test(p) && p !== city);
  return [city, state].filter(Boolean).join(", ") || display;
}

export async function exploreArea(input: { area: string; keyword?: string }): Promise<ExploreResponse> {
  const area = (input.area ?? "").trim();
  const kw = (input.keyword ?? "").trim() || "restaurants";
  if (!area) return { results: [], error: "Enter a zip code or city." };

  const google = getProvider("google");
  if (!google?.isConfigured()) return { results: [], error: "Area search needs the Google Places key (GOOGLE_MAPS_API_KEY)." };

  const geo = await geocodeArea(area);
  const near = geo ? { lat: geo.lat, lng: geo.lng, radiusKm: 12 } : undefined;
  const query = `${kw} in ${area}`;

  // The whole scan is ONE searched category, so classify the keyword ONCE (LLM,
  // classify-tier) to get a polished vertical for the cards — in PARALLEL with the
  // Google fetch so it adds no latency, and only when a keyword was given (a bare
  // "what's here" area scan has no single category → per-business signals decide).
  const searched = (input.keyword ?? "").trim();
  let cands: any[] = [];
  let areaVertical: string | null = null;
  try {
    [cands, areaVertical] = await Promise.all([
      google.discoverProfiles({ query, near, limit: 20 }),
      searched ? smartVertical({ name: searched }) : Promise.resolve(null),
    ]);
  } catch (e) {
    return { results: [], error: (e as Error).message, center: geo ?? undefined, areaLabel: geo?.label };
  }

  let results: ExploreResult[] = cands.map((c: any) => {
    const p = c.raw ?? {};
    const distanceKm = geo && c.geo ? Number(haversineKm(geo, c.geo).toFixed(1)) : undefined;
    return {
      name: c.name,
      rating: p.rating ?? null,
      reviews: p.userRatingCount ?? null,
      address: p.formattedAddress,
      website: c.website,
      geo: c.geo,
      // Confident per-business signal first (a restaurant in a "gym" search stays a
      // restaurant), then the once-classified area vertical (gives fitness/dental/
      // real_estate their real label), then name, then 'other' (card shows the real
      // Google category). Never defaults to restaurant.
      vertical: structuredVertical(c) ?? nameVertical(c) ?? areaVertical ?? "other",
      subtype: subtypeLabel(extractSubtype(c)) ?? "",
      distanceKm,
      mapsUrl: c.url,
      category: p.primaryType,
      placeId: p.id,
    };
  });

  // geo-enforce: drop anything far from the area centroid (same-name elsewhere)
  if (geo) results = results.filter((r) => r.distanceKm == null || r.distanceKm <= 20);
  // rank by quality × popularity (rating weighted by how many reviews back it)
  const score = (r: ExploreResult) => (r.rating ?? 0) * Math.log10((r.reviews ?? 0) + 10);
  results.sort((a, b) => score(b) - score(a));

  return { center: geo ?? undefined, areaLabel: geo?.label, results };
}

/* ────────────────────────────────────────────────────────────────────────────
 * Intelligent market-read — the "one screen that sizes up the area" that turns
 * Explore from a list into a decision tool (and the top-of-funnel hook into
 * Monitor). Deterministic aggregates + one cheap LLM narrative that reads like a
 * local-market analyst. Grounded strictly in the results we found — no invention.
 * ──────────────────────────────────────────────────────────────────────────── */

export interface MarketStats {
  count: number;
  avgRating: number | null;
  ratedShare: number;                                    // 0..1 with a rating
  topRated: { name: string; rating: number | null; reviews: number | null }[];
  mostReviewed: { name: string; reviews: number } | null;
  subtypeMix: { label: string; count: number }[];        // top cuisine/subtypes
  highPerformers: number;                                // ≥4.5★ with ≥50 reviews
}
export interface MarketRead {
  stats: MarketStats;
  headline: string;                                      // the market in one sentence
  readout: string[];                                     // 2–4 analyst bullets
  opportunity: string;                                   // the clearest opening
}

/** Deterministic aggregates over the explored results (no LLM, no cost). */
export function computeMarketStats(results: ExploreResult[]): MarketStats {
  const rated = results.filter((r) => typeof r.rating === "number");
  const avgRating = rated.length ? Number((rated.reduce((s, r) => s + (r.rating as number), 0) / rated.length).toFixed(2)) : null;
  const topRated = results.slice(0, 3).map((r) => ({ name: r.name, rating: r.rating, reviews: r.reviews }));
  const mostReviewed = [...results].sort((a, b) => (b.reviews ?? 0) - (a.reviews ?? 0))[0];
  const mix = new Map<string, number>();
  for (const r of results) { const k = r.subtype || ""; if (k) mix.set(k, (mix.get(k) ?? 0) + 1); }
  const subtypeMix = [...mix.entries()].map(([label, count]) => ({ label, count })).sort((a, b) => b.count - a.count).slice(0, 4);
  const highPerformers = results.filter((r) => (r.rating ?? 0) >= 4.5 && (r.reviews ?? 0) >= 50).length;
  return {
    count: results.length,
    avgRating,
    ratedShare: results.length ? Number((rated.length / results.length).toFixed(2)) : 0,
    topRated,
    mostReviewed: mostReviewed && mostReviewed.reviews != null ? { name: mostReviewed.name, reviews: mostReviewed.reviews } : null,
    subtypeMix,
    highPerformers,
  };
}

const READ_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    headline: { type: "string", description: "One plain-English sentence sizing up this local market at a glance (how crowded, how strong). ≤22 words." },
    readout: { type: "array", items: { type: "string" }, minItems: 2, maxItems: 4, description: "2–4 short analyst observations grounded ONLY in the data given: how competitive it is, who leads and why, the rating bar to clear, any concentration in one cuisine/subtype." },
    opportunity: { type: "string", description: "The single clearest opening for someone opening or competing here — a concrete, specific angle (a gap, an under-served subtype, a quality/reviews bar rivals aren't meeting). 1–2 sentences." },
  },
  required: ["headline", "readout", "opportunity"],
};

const clean = (s: unknown) => String(s ?? "").replace(/<\/?[a-z][^>]*>/gi, "").replace(/\s+/g, " ").trim();

function deterministicRead(area: string, keyword: string, stats: MarketStats): Pick<MarketRead, "headline" | "readout" | "opportunity"> {
  const what = keyword || "places";
  const density = stats.count >= 15 ? "a crowded market" : stats.count >= 6 ? "a moderately competitive market" : "a thin, wide-open market";
  const readout: string[] = [`${stats.count} ${what}${area ? ` near ${area}` : ""} — ${density}.`];
  if (stats.avgRating != null) readout.push(`Average rating is ${stats.avgRating}★; ${stats.highPerformers} clear standouts (4.5★+ with real review volume).`);
  if (stats.topRated[0]) readout.push(`Best-rated: ${stats.topRated[0].name}${stats.topRated[0].rating ? ` (${stats.topRated[0].rating}★)` : ""}.`);
  if (stats.subtypeMix[0]) readout.push(`Most common: ${stats.subtypeMix[0].label} (${stats.subtypeMix[0].count}).`);
  return {
    headline: `${stats.count} ${what}${area ? ` in ${area}` : ""} — ${density}${stats.avgRating != null ? `, averaging ${stats.avgRating}★` : ""}.`,
    readout: readout.slice(0, 4),
    opportunity: stats.avgRating != null
      ? `Clearing ${(Math.min(5, stats.avgRating + 0.3)).toFixed(1)}★ with strong review volume would put you above most rivals here.`
      : `Ratings are sparse here — being the visibly best-reviewed option is an open lane.`,
  };
}

/** Build the intelligent market-read. Cheap LLM narrative over deterministic
 *  stats; falls back to a deterministic read when the LLM is off or errors. */
export async function marketRead(input: { area: string; keyword?: string; results: ExploreResult[] }): Promise<MarketRead> {
  const keyword = (input.keyword ?? "").trim();
  const stats = computeMarketStats(input.results);
  if (!stats.count) return { stats, ...deterministicRead(input.area, keyword, stats) };
  if (!isLlmConfigured()) return { stats, ...deterministicRead(input.area, keyword, stats) };

  const list = input.results.slice(0, 15).map((r, i) =>
    `${i + 1}. ${r.name} — ${r.rating != null ? `${r.rating}★` : "no rating"}, ${r.reviews ?? 0} reviews${r.subtype ? `, ${r.subtype}` : ""}`,
  ).join("\n");
  const system = "You are a sharp local-market analyst. Given the businesses found in an area, size up the market for someone opening or competing there. Be specific and grounded ONLY in the data provided — never invent names, numbers, or facts. Plain English, no fluff.";
  const text = `AREA: ${input.area}\nLOOKING FOR: ${keyword || "local businesses"}\nFOUND ${stats.count} (avg ${stats.avgRating ?? "n/a"}★, ${stats.highPerformers} standouts). Ranked by quality × popularity:\n${list}`;
  try {
    const { data } = await getLlm().callStructured<{ headline: string; readout: string[]; opportunity: string }>({ system, text, schema: READ_SCHEMA, tier: "classify", maxTokens: 500 });
    const readout = (Array.isArray(data.readout) ? data.readout : []).map(clean).filter(Boolean).slice(0, 4);
    const headline = clean(data.headline);
    const opportunity = clean(data.opportunity);
    if (!headline || readout.length < 2 || !opportunity) return { stats, ...deterministicRead(input.area, keyword, stats) };
    return { stats, headline, readout, opportunity };
  } catch {
    return { stats, ...deterministicRead(input.area, keyword, stats) };
  }
}
