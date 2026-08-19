import { createServiceClient } from "@/lib/supabase/server";
import { getProvider } from "@/lib/providers/registry";
import { getLlm, isLlmConfigured } from "@/lib/extraction/llm";
import { spendForCost } from "@/lib/credits";
import { type WorkspaceRow } from "@/lib/workspace";

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
