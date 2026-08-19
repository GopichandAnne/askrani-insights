import { createServiceClient } from "@/lib/supabase/server";
import { getProvider } from "@/lib/providers/registry";
import { getLlm, isLlmConfigured } from "@/lib/extraction/llm";
import { spendForCost } from "@/lib/credits";
import { type WorkspaceRow } from "@/lib/workspace";
import { staleCached } from "@/lib/staleCache";

/**
 * Findability — collection engine (headless). Tracks where a workspace's target
 * business ranks in Google search for the real-world terms customers type, per
 * keyword, vs the same competitor set. Reuses the Google provider, the competitor
 * edges, and the append-only snapshot discipline (market_snapshot). Metered:
 * weekly cron is plan-included (records COGS only); on-demand charges credits.
 */

// deno? no — Next server. Loose service-client type (the client is untyped).
type Svc = ReturnType<typeof createServiceClient>;

export const FINDABILITY_REFRESH_CREDITS = 5; // on-demand cost (tunable)
const KEYWORD_TARGET = 12;
const DEFAULT_RUNS = 2;               // median-of-N per keyword (§2 volatility)
const ANCHOR_RADIUS_KM = 8;           // locationBias radius around the practice
const NOT_FOUND = 21;                 // sentinel rank when target isn't in the top 20
const MATCH_KM = 0.12;                // a result within 120m of a business IS that business
// Google Places Text Search (Pro SKU) ≈ $0.032 / call — COGS, recorded not charged.
const PLACES_COST_PER_CALL = 0.032;

export type Intent = "everyday" | "urgent" | "high_value";
export interface RefreshResult { activated: boolean; keywords: number; snapshots: number; found: number; costUsd: number }

// ── keyword generation ──────────────────────────────────────────────────────
const KW_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    keywords: {
      type: "array",
      maxItems: KEYWORD_TARGET,
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          term: { type: "string", description: "the exact Google search phrase a local customer types to find this kind of business, INCLUDING the city. lowercase, no punctuation. e.g. 'emergency dentist round rock'." },
          intent: { type: "string", enum: ["everyday", "urgent", "high_value"], description: "everyday = routine, highest volume; urgent = time-critical; high_value = expensive, high-margin services." },
          value_weight: { type: "number", description: "1 to 3 — how much revenue this term represents (routine ~1, high-value services ~3)." },
        },
        required: ["term", "intent", "value_weight"],
      },
    },
  },
  required: ["keywords"],
};
const KW_SYSTEM =
  "You list the real-world Google searches local customers type to FIND a business like this one — the terms it must rank for. Return about 12, spread across everyday (routine, highest volume), urgent (time-critical), and high_value (expensive, high-margin services). Every term is a realistic search phrase that INCLUDES the city, lowercase, no punctuation. Weight high-value services heavier. Ground the terms strictly in THIS business's category and services — no generic filler.";

/** Generate + persist the tracked keywords for a workspace. Fail-soft → 0. */
export async function generateFindabilityKeywords(
  svc: Svc, ws: WorkspaceRow, orgId: string,
  biz: { name: string; city: string; category?: string; subtype?: string },
): Promise<number> {
  if (!isLlmConfigured()) return 0;
  let gen: { term: string; intent: Intent; value_weight: number }[] = [];
  try {
    const { data } = await getLlm().callStructured<{ keywords: typeof gen }>({
      system: KW_SYSTEM,
      text: `BUSINESS: ${biz.name}\nCATEGORY: ${biz.category ?? ws.vertical}\nVERTICAL: ${ws.vertical}${biz.subtype ? `\nSPECIALTY: ${biz.subtype}` : ""}\nCITY: ${biz.city || "(unknown — infer from context)"}`,
      schema: KW_SCHEMA, tier: "classify", maxTokens: 700,
    });
    gen = data?.keywords ?? [];
  } catch { return 0; }

  const seen = new Set<string>();
  const rows = gen
    .map((k) => ({
      term: String(k.term ?? "").trim().toLowerCase().replace(/["']/g, "").slice(0, 120),
      intent: (["everyday", "urgent", "high_value"].includes(k.intent) ? k.intent : "everyday") as Intent,
      value_weight: Math.min(3, Math.max(1, Number(k.value_weight) || 1)),
    }))
    .filter((k) => k.term.length > 3 && !seen.has(k.term) && seen.add(k.term))
    .slice(0, KEYWORD_TARGET)
    .map((k) => ({ workspace_id: ws.id, organization_id: orgId, active: true, ...k }));
  if (!rows.length) return 0;
  await svc.from("findability_keyword").upsert(rows, { onConflict: "workspace_id,term", ignoreDuplicates: true });
  return rows.length;
}

// ── name matching (find the target + competitors in the ranked results) ──────
const norm = (s: string) =>
  (s ?? "").toLowerCase().replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\b(the|a|an|of|and|dental|dentistry|dentist|dentists|orthodontics|clinic|center|centre|studio|office|group|associates|family|care|llc|pllc|pc|dds|dmd|md|inc|co)\b/g, " ")
    .replace(/\s+/g, " ").trim();

/** True when `cand` is (probably) the same business as `target`, by name. */
function nameMatches(target: string, cand: string): boolean {
  const t = norm(target), c = norm(cand);
  if (!t || !c) return false;
  if (t === c) return true;
  const tt = t.split(" ").filter((w) => w.length > 2);
  const ct = new Set(c.split(" ").filter((w) => w.length > 2));
  if (!tt.length) return false;
  const hit = tt.filter((w) => ct.has(w)).length;
  return hit / tt.length >= 0.6; // ≥60% of the target's distinctive tokens present
}

const median = (xs: number[]): number => {
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : Math.round((s[m - 1] + s[m]) / 2);
};

function cityFromAddress(addr?: string): string {
  if (!addr) return "";
  const parts = String(addr).split(",").map((s) => s.trim()).filter(Boolean);
  return parts.length >= 3 ? parts[parts.length - 3] : parts[0] ?? "";
}
const subtypeStr = (x: unknown): string => (Array.isArray(x) ? x.filter(Boolean).join(" / ") : String(x ?? ""));

type Geo = { lat?: number; lng?: number } | undefined;
function haversineKm(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
  const R = 6371, dLat = (b.lat - a.lat) * Math.PI / 180, dLng = (b.lng - a.lng) * Math.PI / 180;
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * Math.PI / 180) * Math.cos(b.lat * Math.PI / 180) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}
/** Is this search result the same business as `ref`? Geo proximity is exact-ish
 *  (two practices aren't at one point) — so it beats name matching for generic
 *  names; fall back to the name only when a geo is missing. */
function isSame(cand: { name: string; geo?: Geo }, ref: { name: string; geo?: Geo }): boolean {
  if (cand.geo?.lat != null && cand.geo?.lng != null && ref.geo?.lat != null && ref.geo?.lng != null) {
    return haversineKm({ lat: cand.geo.lat, lng: cand.geo.lng }, { lat: ref.geo.lat, lng: ref.geo.lng }) <= MATCH_KM;
  }
  return nameMatches(ref.name, cand.name);
}

// ── the refresh ─────────────────────────────────────────────────────────────
/** Collect + snapshot findability ranks for one workspace. Never throws; returns
 *  a summary. Records Places COGS (not credit-charged — the caller decides). */
export async function refreshFindability(ws: WorkspaceRow, opts: { runs?: number } = {}): Promise<RefreshResult> {
  const empty: RefreshResult = { activated: false, keywords: 0, snapshots: 0, found: 0, costUsd: 0 };
  const svc = createServiceClient();
  const google = getProvider("google");
  if (!google?.isConfigured()) return empty;

  const { data: wsRow } = await svc.from("workspace").select("organization_id, target_business_id").eq("id", ws.id).maybeSingle();
  const orgId = wsRow?.organization_id as string | undefined;
  const targetId = wsRow?.target_business_id as string | undefined;
  if (!orgId || !targetId) return empty;

  const { data: target } = await svc.from("business").select("canonical_name, attributes").eq("id", targetId).maybeSingle();
  const attrs = (target?.attributes ?? {}) as Record<string, unknown>;
  const geo = attrs.geo as { lat?: number; lng?: number } | undefined;
  const targetName = (target?.canonical_name as string) ?? "";
  if (!geo?.lat || !geo?.lng || !targetName) return empty;

  const { data: edges } = await svc.from("competitor_edge").select("competitor:competitor_id(canonical_name, attributes)").eq("workspace_id", ws.id);
  const competitors = ((edges ?? []) as { competitor?: { canonical_name?: string; attributes?: Record<string, unknown> } }[])
    .map((e) => ({ name: e.competitor?.canonical_name ?? "", geo: (e.competitor?.attributes as { geo?: Geo } | undefined)?.geo }))
    .filter((c) => c.name);
  const targetRef = { name: targetName, geo: geo as Geo };

  // keywords — generate on first run
  const loadKw = () => svc.from("findability_keyword").select("id, term, intent, value_weight").eq("workspace_id", ws.id).eq("active", true);
  let { data: kws } = await loadKw();
  if (!kws?.length) {
    await generateFindabilityKeywords(svc, ws, orgId, {
      name: targetName, city: cityFromAddress(attrs.address as string), category: attrs.category as string, subtype: subtypeStr(attrs.subtype),
    });
    ({ data: kws } = await loadKw());
  }
  if (!kws?.length) return { ...empty, activated: true };

  const runs = Math.min(3, Math.max(1, opts.runs ?? DEFAULT_RUNS));
  const near = { lat: geo.lat, lng: geo.lng, radiusKm: ANCHOR_RADIUS_KM };
  const today = new Date().toISOString().slice(0, 10);
  let calls = 0, found = 0;
  const rows: Record<string, unknown>[] = [];

  for (const kw of kws as { id: string; term: string; intent: Intent }[]) {
    const positions: number[] = [];
    let lastCands: { name: string; geo?: Geo }[] = [];
    for (let i = 0; i < runs; i++) {
      const cands = await google.discoverProfiles({ query: kw.term, near, limit: 20 });
      calls++;
      lastCands = cands.map((c) => ({ name: c.name, geo: c.geo }));
      const idx = lastCands.findIndex((c) => isSame(c, targetRef));
      positions.push(idx >= 0 ? idx + 1 : NOT_FOUND);
    }
    const med = median(positions);
    const yourRank = med <= 20 ? med : null;
    const confidence = new Set(positions).size === 1; // repeat runs agreed exactly
    if (yourRank != null) found++;

    const compRanks: Record<string, number> = {};
    lastCands.forEach((cand, i) => {
      for (const cp of competitors) if (compRanks[cp.name] == null && isSame(cand, cp)) compRanks[cp.name] = i + 1;
    });
    let topComp: string | null = null, best = Infinity;
    for (const [cn, pos] of Object.entries(compRanks)) if (pos < best) { best = pos; topComp = cn; }
    if (!topComp && lastCands[0]) topComp = lastCands[0].name; // else whoever ranks #1

    rows.push({
      captured_on: today, workspace_id: ws.id, organization_id: orgId, keyword_id: kw.id,
      term: kw.term, intent: kw.intent, your_rank: yourRank, confidence,
      results_count: lastCands.length, top_competitor: topComp, competitor_ranks: compRanks,
    });
  }

  if (rows.length) {
    await svc.from("findability_snapshot").upsert(rows, { onConflict: "workspace_id,keyword_id,captured_on", ignoreDuplicates: true });
  }
  const costUsd = Number((calls * PLACES_COST_PER_CALL).toFixed(4));
  try { await spendForCost(orgId, costUsd, { kind: "findability_refresh", workspaceId: ws.id, calls }); } catch { /* record-only */ }

  return { activated: true, keywords: kws.length, snapshots: rows.length, found, costUsd };
}

// ── derived reads (phase 2) — the score + metrics for the pillar UI ──────────
export interface FKeywordRead { term: string; intent: Intent; yourRank: number | null; topCompetitor: string | null; trend: number | null; confidence: boolean }
export interface FShareRow { name: string; isYou: boolean; topThree: number; total: number }
export interface FindabilityReport {
  at: string;
  empty: boolean;
  capturedOn: string | null;
  score: number;                 // 0-100
  scoreDelta: number | null;     // vs the prior snapshot window
  breakdown: { position: number; coverage: number; momentum: number };
  avgPosition: number | null;    // mean rank where you appear
  avgPositionDelta: number | null; // + = improved (lower avg rank)
  coverage: { inTop3: number; total: number };
  biggestSlip: { term: string; from: number | null; to: number | null } | null;
  keywords: FKeywordRead[];      // sorted by intent then rank
  share: FShareRow[];            // top-3 share of local search, you + competitors
  keywordCount: number;
  recommendation: string | null; // "what to do" — the single most valuable action
}

interface Snap { keyword_id: string; term: string; intent: Intent; your_rank: number | null; confidence: boolean; top_competitor: string | null; competitor_ranks: Record<string, number>; captured_on: string }

// #1 = 100 … #20 = 5, not-found = 0. Linear, simple, defensible.
const rankScore = (r: number | null) => (r == null ? 0 : Math.max(0, Math.round((100 * (21 - r)) / 20)));
const clamp = (n: number, lo = 0, hi = 100) => Math.min(hi, Math.max(lo, n));
const INTENT_ORDER: Record<Intent, number> = { everyday: 0, urgent: 1, high_value: 2 };

function subScores(snaps: Snap[], weights: Map<string, number>) {
  let wSum = 0, posW = 0, inTop3 = 0; const found: number[] = [];
  for (const s of snaps) {
    const w = weights.get(s.keyword_id) ?? 1;
    wSum += w; posW += w * rankScore(s.your_rank);
    if (s.your_rank != null) { found.push(s.your_rank); if (s.your_rank <= 3) inTop3++; }
  }
  return {
    position: wSum ? Math.round(posW / wSum) : 0,                       // value-weighted position strength
    coverage: snaps.length ? Math.round((100 * inTop3) / snaps.length) : 0,
    avg: found.length ? Math.round(found.reduce((a, b) => a + b, 0) / found.length) : null,
    inTop3,
  };
}

const emptyReport = (): FindabilityReport => ({
  at: new Date().toISOString(), empty: true, capturedOn: null, score: 0, scoreDelta: null,
  breakdown: { position: 0, coverage: 0, momentum: 50 }, avgPosition: null, avgPositionDelta: null,
  coverage: { inTop3: 0, total: 0 }, biggestSlip: null, keywords: [], share: [], keywordCount: 0, recommendation: null,
});

// ── "what to do" — one grounded action from the findability picture ──────────
const REC_SCHEMA = {
  type: "object", additionalProperties: false,
  properties: { action: { type: "string", description: "one or two sentences: the single most valuable action to improve findability this week, grounded in the data — concrete and specific, no lists, no fluff." } },
  required: ["action"],
};
const REC_SYSTEM =
  "You advise a local business on getting found in Google search. From its search-rank data — where it ranks for the terms customers type vs its competitors — write the SINGLE most valuable action to take this week, in 1-2 concrete sentences. Prioritize the high-value terms it's buried or slipping on and where a specific competitor is beating it. Plain, direct, no lists.";

async function makeRecommendation(ws: WorkspaceRow, keywords: FKeywordRead[], share: FShareRow[], biggestSlip: FindabilityReport["biggestSlip"]): Promise<string | null> {
  if (!isLlmConfigured() || !keywords.length) return null;
  const weak = keywords.filter((k) => k.intent === "high_value" && (k.yourRank == null || k.yourRank > 3)).slice(0, 4);
  const leaders = share.filter((s) => !s.isYou).slice(0, 3);
  const text = `BUSINESS vertical: ${ws.vertical}\n`
    + `HIGH-VALUE terms you're weak on: ${weak.map((k) => `"${k.term}" (${k.yourRank ? "#" + k.yourRank : "not ranking"}${k.topCompetitor ? `, rival ${k.topCompetitor}` : ""})`).join("; ") || "none"}\n`
    + `Biggest slip: ${biggestSlip ? `"${biggestSlip.term}" → ${biggestSlip.to ? "#" + biggestSlip.to : "not ranking"}` : "none"}\n`
    + `Competitors leading local search: ${leaders.map((l) => `${l.name} (${l.topThree}/${l.total})`).join(", ") || "none"}`;
  try {
    const { data } = await getLlm().callStructured<{ action: string }>({ system: REC_SYSTEM, text, schema: REC_SCHEMA, tier: "classify", maxTokens: 160 });
    return String(data?.action ?? "").trim() || null;
  } catch { return null; }
}

/** Compute the Findability score + reads from the snapshots. Read-only; no cost. */
export async function buildFindabilityReport(ws: WorkspaceRow): Promise<FindabilityReport> {
  const svc = createServiceClient();
  const since = new Date(Date.now() - 45 * 86_400_000).toISOString().slice(0, 10);
  const { data: kwRows } = await svc.from("findability_keyword").select("id, value_weight").eq("workspace_id", ws.id);
  const weights = new Map<string, number>(((kwRows ?? []) as { id: string; value_weight: number }[]).map((k) => [k.id, Number(k.value_weight) || 1]));
  const { data: rows } = await svc.from("findability_snapshot")
    .select("keyword_id, term, intent, your_rank, confidence, top_competitor, competitor_ranks, captured_on")
    .eq("workspace_id", ws.id).gte("captured_on", since).order("captured_on", { ascending: false });
  const snaps = (rows ?? []) as Snap[];
  if (!snaps.length) return emptyReport();

  const days = [...new Set(snaps.map((s) => s.captured_on))].sort().reverse();
  const current = days[0];
  const cur = snaps.filter((s) => s.captured_on === current);
  // Prior = the most recent day ≥5 days back (weekly), else yesterday's, else none.
  const priorDay = days.find((d) => Date.parse(current) - Date.parse(d) >= 5 * 86_400_000) ?? days[1] ?? null;
  const prior = priorDay ? snaps.filter((s) => s.captured_on === priorDay) : [];
  const priorRank = new Map(prior.map((s) => [s.keyword_id, s.your_rank]));

  const c = subScores(cur, weights);
  const p = prior.length ? subScores(prior, weights) : null;

  // Momentum: mean rank improvement vs prior (positive = better), mapped to 0-100.
  const deltas: number[] = [];
  for (const s of cur) { const pr = priorRank.get(s.keyword_id); if (pr != null && s.your_rank != null) deltas.push(pr - s.your_rank); }
  const avgDelta = deltas.length ? deltas.reduce((a, b) => a + b, 0) / deltas.length : 0;
  const momentum = deltas.length ? clamp(Math.round(50 + avgDelta * 8)) : 50;

  const score = Math.round(0.55 * c.position + 0.25 * c.coverage + 0.2 * momentum);
  const scoreDelta = p ? score - Math.round(0.55 * p.position + 0.25 * p.coverage + 0.2 * 50) : null;

  const keywords: FKeywordRead[] = cur
    .map((s) => {
      const pr = priorRank.get(s.keyword_id);
      return { term: s.term, intent: s.intent, yourRank: s.your_rank, topCompetitor: s.top_competitor, trend: pr != null && s.your_rank != null ? pr - s.your_rank : null, confidence: s.confidence };
    })
    .sort((a, b) => INTENT_ORDER[a.intent] - INTENT_ORDER[b.intent] || (a.yourRank ?? 99) - (b.yourRank ?? 99));

  // Biggest slip: worst rank drop vs prior; else the weakest high-value term.
  let biggestSlip: FindabilityReport["biggestSlip"] = null;
  const worsened = keywords.filter((k) => k.trend != null && k.trend < 0).sort((a, b) => (a.trend as number) - (b.trend as number));
  if (worsened.length) {
    const k = worsened[0];
    biggestSlip = { term: k.term, from: k.yourRank != null && k.trend != null ? k.yourRank + k.trend : null, to: k.yourRank };
  } else {
    const hv = keywords.filter((k) => k.intent === "high_value").sort((a, b) => (b.yourRank ?? 99) - (a.yourRank ?? 99))[0];
    if (hv) biggestSlip = { term: hv.term, from: null, to: hv.yourRank };
  }

  // Share of local search: top-3 count for you + each competitor, across all terms.
  const total = cur.length; let youTop3 = 0; const compTop3 = new Map<string, number>();
  for (const s of cur) {
    if (s.your_rank != null && s.your_rank <= 3) youTop3++;
    for (const [name, pos] of Object.entries(s.competitor_ranks ?? {})) if (pos <= 3) compTop3.set(name, (compTop3.get(name) ?? 0) + 1);
  }
  const share: FShareRow[] = [{ name: "You", isYou: true, topThree: youTop3, total },
    ...[...compTop3].map(([name, cnt]) => ({ name, isYou: false, topThree: cnt, total }))]
    .sort((a, b) => b.topThree - a.topThree).slice(0, 6);

  const recommendation = await makeRecommendation(ws, keywords, share, biggestSlip);

  return {
    at: new Date().toISOString(), empty: false, capturedOn: current, score, scoreDelta,
    breakdown: { position: c.position, coverage: c.coverage, momentum },
    avgPosition: c.avg, avgPositionDelta: p && p.avg != null && c.avg != null ? p.avg - c.avg : null,
    coverage: { inTop3: c.inTop3, total }, biggestSlip, keywords, share, keywordCount: cur.length, recommendation,
  };
}

/** Cached report — served instantly, regenerated when stale. */
export function getOrMakeFindabilityReport(ws: WorkspaceRow, maxAgeHours = 6): Promise<FindabilityReport> {
  return staleCached(ws, "findability", maxAgeHours, () => buildFindabilityReport(ws), { isValid: (c) => !c.empty });
}

/** The compact summary the weekly digest reads (goals.findabilityBrief) — so the
 *  brief comes from cached goals with no scrape/LLM at digest time. */
export interface FindabilityBrief {
  score: number; scoreDelta: number | null; biggestSlip: FindabilityReport["biggestSlip"];
  topRival: string | null; coverage: { inTop3: number; total: number }; recommendation: string | null; capturedOn: string | null;
}
export async function computeFindabilityBrief(ws: WorkspaceRow): Promise<FindabilityBrief | null> {
  const r = await buildFindabilityReport(ws);
  if (r.empty) return null;
  return { score: r.score, scoreDelta: r.scoreDelta, biggestSlip: r.biggestSlip, topRival: r.share.find((s) => !s.isYou)?.name ?? null, coverage: r.coverage, recommendation: r.recommendation, capturedOn: r.capturedOn };
}
