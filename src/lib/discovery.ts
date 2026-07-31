import { createServiceClient } from "@/lib/supabase/server";
import { discoverCandidates } from "@/lib/providers/registry";
import type { ProfileCandidate } from "@/lib/providers/types";
import { extractSubtype, subtypeSimilarity, inferVertical, structuredVertical, isNonFood } from "@/lib/classify";

/**
 * Discovery service — guide §2.2 (onboarding) + §9 (competitor graph).
 *
 * Turns a business search into a persisted workspace: resolve the canonical
 * business, then auto-find and rank nearby competitors and store them as
 * competitor_edges with explainable score_components. All writes use the
 * service-role client; the caller supplies an org id resolved from the verified
 * auth user (never client input).
 */

export interface CompetitorRow {
  edgeId: string;
  businessId: string;
  name: string;
  website?: string;
  distanceKm?: number;
  relation: string;
  score: number;
}

function originOf(url?: string): string | undefined {
  if (!url) return undefined;
  try {
    return new URL(url).origin;
  } catch {
    return undefined;
  }
}

function tokens(s?: string): Set<string> {
  return new Set(
    (s ?? "")
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((t) => t.length > 2),
  );
}

/** How well a candidate name matches the search query (0..1). Handles spacing
 *  variants ("Man Pasand" vs "Manpasand") via a spaceless-substring check. */
function nameRelevance(query: string, name: string): number {
  const qt = tokens(query);
  const nt = tokens(name);
  let shared = 0;
  for (const t of nt) if (qt.has(t)) shared++;
  const overlap = nt.size ? shared / nt.size : 0;
  const qc = query.toLowerCase().replace(/[^a-z0-9]/g, "");
  const nc = name.toLowerCase().replace(/[^a-z0-9]/g, "");
  const sub = qc && nc && (qc.includes(nc) || nc.includes(qc)) ? 1 : 0;
  let tokenIn = 0;
  for (const t of qt) if (t.length >= 3 && nc.includes(t)) { tokenIn = 0.6; break; }
  return Math.max(overlap, sub, tokenIn);
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (!a.size || !b.size) return 0;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  return inter / (a.size + b.size - inter);
}

/**
 * Competitor ranking — guide §9.2 default weights, restricted to the signals
 * we have at discovery time (geo, category, prominence). offering_similarity,
 * price_tier and audience are filled after collection, so we re-normalize over
 * the available components and record which were used.
 */
export function scoreCompetitor(
  target: { category?: string; subtype?: string[] },
  cand: ProfileCandidate,
  radiusKm: number,
): { score: number; components: Record<string, unknown> } {
  const geoOverlap = cand.distanceKm != null ? 1 - Math.min(cand.distanceKm / radiusKm, 1) : 0.5;
  const categorySim = jaccard(tokens(target.category), tokens(cand.category)) || 0.4;
  const prominence = Math.max(0, Math.min(1, cand.prominence ?? 0));

  // Subtype (cuisine/ethnicity) similarity — the "like-for-like" signal. Only
  // weighted when the target actually has a subtype; otherwise we re-normalize
  // over geo/category/prominence so a generic business isn't penalized.
  const targetSubtype = target.subtype ?? [];
  const candSubtype = extractSubtype(cand as any);
  const hasSubtype = targetSubtype.length > 0;
  const subtypeSim = hasSubtype ? subtypeSimilarity(targetSubtype, candSubtype) : 0;

  let score: number;
  if (hasSubtype) {
    // like-for-like leads; geo close behind (guide §9.2, re-normalized).
    score = 0.34 * subtypeSim + 0.33 * geoOverlap + 0.13 * categorySim + 0.2 * prominence;
  } else {
    score = 0.45 * geoOverlap + 0.3 * categorySim + 0.25 * prominence;
  }
  return {
    score: Number(score.toFixed(4)),
    components: {
      subtype_similarity: hasSubtype ? Number(subtypeSim.toFixed(3)) : null,
      subtype_matched: hasSubtype ? candSubtype.filter((s) => targetSubtype.includes(s)) : [],
      geo_overlap: Number(geoOverlap.toFixed(3)),
      category_similarity: Number(categorySim.toFixed(3)),
      prominence: Number(prominence.toFixed(3)),
      offering_similarity: null, // pending collection
      price_tier_similarity: null,
      audience_similarity: null,
      note: hasSubtype
        ? "onboarding v2: like-for-like subtype + geo + category + prominence; offering/price/audience fill after collection"
        : "onboarding v1: geo+category+prominence; offering/price/audience fill after collection",
    },
  };
}

type Svc = ReturnType<typeof createServiceClient>;

/** Upsert a business (+ location + website/social identities). Match by website
 *  origin when present, else by (name, vertical). */
export async function upsertBusiness(
  svc: Svc,
  cand: { name: string; website?: string; geo?: { lat: number; lng: number }; category?: string; raw?: any },
  vertical: string,
): Promise<string> {
  const website = originOf(cand.website);

  let existingId: string | undefined;
  if (website) {
    const { data } = await svc.from("business").select("id").eq("website", website).limit(1).maybeSingle();
    existingId = data?.id;
  }
  if (!existingId) {
    const { data } = await svc
      .from("business")
      .select("id")
      .ilike("canonical_name", cand.name)
      .eq("vertical", vertical)
      .limit(1)
      .maybeSingle();
    existingId = data?.id;
  }

  let businessId = existingId;
  if (!businessId) {
    // Store lat/lng in attributes (avoids PostGIS WKT-cast issues over PostgREST;
    // the geography column can be backfilled by a worker later).
    const address = cand.raw?.address
      ? Object.values(cand.raw.address).filter(Boolean).join(", ")
      : undefined;
    const subtype = extractSubtype(cand as any);
    const { data, error } = await svc
      .from("business")
      .insert({
        canonical_name: cand.name,
        website,
        vertical,
        category: cand.category ?? vertical,
        confidence: 0.7,
        attributes: {
          ...(cand.geo ? { geo: cand.geo } : {}),
          ...(address ? { address } : {}),
          ...(subtype.length ? { subtype } : {}),
        },
      })
      .select("id")
      .single();
    if (error) throw new Error(`business insert: ${error.message}`);
    businessId = data.id as string;
  }

  // external identities: website + any social handles OSM/Google surfaced.
  // Check-then-insert (our uniqueness is an expression index, not a plain
  // constraint PostgREST can target with onConflict).
  const identities: { platform: string; url: string }[] = [];
  if (website) identities.push({ platform: "website", url: website });
  const ex = cand.raw?.extratags ?? {};
  for (const [k, plat] of [
    ["contact:facebook", "facebook"],
    ["contact:instagram", "instagram"],
    ["contact:twitter", "twitter"],
  ] as const) {
    if (ex[k]) identities.push({ platform: plat, url: ex[k] });
  }
  for (const id of identities) {
    const { data: existing } = await svc
      .from("external_identity")
      .select("id")
      .eq("business_id", businessId)
      .eq("platform", id.platform)
      .limit(1)
      .maybeSingle();
    if (!existing) {
      const { error: iErr } = await svc
        .from("external_identity")
        .insert({ business_id: businessId, platform: id.platform, url: id.url, verification_state: "observed" });
      if (iErr) {
        /* ignore dup/constraint races — best-effort enrichment */
      }
    }
  }

  return businessId!;
}

/** Search for the user's business (or any business) across configured providers.
 *  Each result carries a detected vertical + subtype so onboarding doesn't have
 *  to ask, and can prioritize like-for-like competitors. */
export async function searchBusinesses(query: string, near?: { lat: number; lng: number }) {
  const cands = await discoverCandidates({ query, near, vertical: "restaurant", limit: 10 });

  // Brand-consistency: a brand is one vertical. If some listings for a name have
  // a confident structured signal (e.g. one "Patel Brothers" is a Google
  // grocery) but others are sparse and would name-default to restaurant, apply
  // the confident vertical to the whole name-group. Skip on conflict.
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  const sigsByName = new Map<string, Set<"grocery" | "restaurant">>();
  for (const c of cands) {
    const sig = structuredVertical(c as any);
    if (!sig) continue;
    const k = norm(c.name);
    if (!sigsByName.has(k)) sigsByName.set(k, new Set());
    sigsByName.get(k)!.add(sig);
  }

  // "Strong" = a well-corroborated listing: a Google POI, a confirmed food type,
  // or one with its own website. Bare OSM entries (name + geo only) are weak.
  const isStrong = (c: (typeof cands)[number]) =>
    c.platform === "google" || structuredVertical(c as any) !== null || !!c.website;

  // Relevance filter: drop Nominatim noise (person names, addresses, admin areas
  // that matched the location tokens). Keep a candidate only if it's locatable
  // AND is either a Google Places business, a name match, a confirmed food
  // business (structured type), or has its own website.
  const prelim = cands
    .map((c) => ({ c, rel: nameRelevance(query, c.name) }))
    .filter(({ c, rel }) => {
      if (!c.geo) return false; // unlocatable → useless for market intel
      if (isNonFood(c as any)) return false; // drop clothing/salon/etc. by type
      return c.platform === "google" || rel > 0 || structuredVertical(c as any) !== null || !!c.website;
    });

  // Chain-query de-noise: a chain name (e.g. "Patel Brothers") comes back from
  // Nominatim as many bare entries at scattered locations. When a well-
  // corroborated (strong) listing for that exact name exists, drop the weak
  // bare-OSM duplicates; keep weak ones only when no strong twin exists.
  const strongNames = new Set<string>();
  for (const { c } of prelim) if (isStrong(c)) strongNames.add(norm(c.name));
  const deNoised = prelim.filter(({ c }) => isStrong(c) || !strongNames.has(norm(c.name)));

  // Rank by how well the name matches the query, with prominence as a tiebreak.
  const ranked = deNoised
    .sort((a, b) => b.rel * 0.6 + (b.c.prominence ?? 0) * 0.4 - (a.rel * 0.6 + (a.c.prominence ?? 0) * 0.4))
    .slice(0, 12)
    .map(({ c }) => c);

  return ranked.map((c) => {
    let detectedVertical = inferVertical(c as any);
    const consensus = sigsByName.get(norm(c.name));
    if (consensus && consensus.size === 1) detectedVertical = [...consensus][0];
    return {
      name: c.name,
      website: c.website,
      geo: c.geo,
      category: c.category,
      address: (c.raw as any)?.address ? Object.values((c.raw as any).address).filter(Boolean).join(", ") : undefined,
      platform: c.platform,
      detectedVertical,
      subtype: extractSubtype(c as any),
      raw: c.raw,
    };
  });
}

/** Resolve the picked candidate into a persisted business + workspace. */
export async function createWorkspaceFromCandidate(
  orgId: string,
  cand: { name: string; website?: string; geo?: { lat: number; lng: number }; category?: string; raw?: any },
  vertical: string = "restaurant",
): Promise<{ workspaceId: string; businessId: string; geo?: { lat: number; lng: number }; vertical: string; subtype: string[] }> {
  const svc = createServiceClient();
  const businessId = await upsertBusiness(svc, cand, vertical);
  const subtype = extractSubtype(cand as any);

  const { data: existingWs } = await svc
    .from("workspace")
    .select("id")
    .eq("organization_id", orgId)
    .eq("target_business_id", businessId)
    .limit(1)
    .maybeSingle();

  let workspaceId = existingWs?.id as string | undefined;
  if (!workspaceId) {
    const { data, error } = await svc
      .from("workspace")
      .insert({ organization_id: orgId, name: cand.name, vertical, target_business_id: businessId })
      .select("id")
      .single();
    if (error) throw new Error(`workspace insert: ${error.message}`);
    workspaceId = data.id as string;
  } else {
    // keep the workspace + business vertical in sync (e.g. user overrode the
    // auto-detected type before starting)
    await svc.from("workspace").update({ vertical }).eq("id", workspaceId);
    await svc.from("business").update({ vertical }).eq("id", businessId);
  }
  return { workspaceId, businessId, geo: cand.geo, vertical, subtype };
}

/** Auto-discover, rank and persist competitors near the target business. */
export async function autoDiscoverCompetitors(
  workspaceId: string,
  target: { businessId: string; name: string; geo?: { lat: number; lng: number }; category?: string; subtype?: string[] },
  opts: { radiusKm?: number; limit?: number; vertical?: string } = {},
): Promise<CompetitorRow[]> {
  if (!target.geo) return [];
  const radiusKm = opts.radiusKm ?? 3;
  const limit = opts.limit ?? 12;
  const vertical = opts.vertical ?? "restaurant";
  const svc = createServiceClient();

  // Target subtype drives a like-for-like discovery pass + ranking. Fall back to
  // the stored attributes if the caller didn't pass one.
  let subtype = target.subtype ?? [];
  if (!subtype.length) {
    const { data: tb } = await svc.from("business").select("attributes").eq("id", target.businessId).maybeSingle();
    subtype = ((tb?.attributes as any)?.subtype as string[]) ?? [];
  }

  const cands = await discoverCandidates({
    near: { ...target.geo, radiusKm },
    vertical,
    limit: 40,
    subtypeTerms: subtype,
  });
  const targetName = target.name.toLowerCase().trim();

  // Vertical consistency: the like-for-like OSM passes ("indian supermarket")
  // are free-text and can pull in same-cuisine *restaurants*; keep only
  // candidates whose own type matches the target vertical (a grocery's rivals
  // are groceries, a restaurant's are restaurants).
  const scored = cands
    .filter((c) => c.name.toLowerCase().trim() !== targetName)
    .filter((c) => inferVertical(c as any) === vertical)
    .map((c) => ({ cand: c, ...scoreCompetitor({ category: target.category, subtype }, c, radiusKm) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);

  const rows: CompetitorRow[] = [];
  for (const [i, s] of scored.entries()) {
    const compId = await upsertBusiness(
      svc,
      { name: s.cand.name, website: s.cand.website, geo: s.cand.geo, category: s.cand.category, raw: s.cand.raw },
      vertical,
    );
    if (compId === target.businessId) continue;
    const relation = i < 5 ? "primary" : "secondary";
    const tier = i < 5 ? "priority" : "standard";
    const matched = (s.components as any).subtype_matched as string[] | undefined;
    const like = matched?.length ? `same type (${matched.join(", ").replace(/_/g, " ")}) · ` : "";
    const { data, error } = await svc
      .from("competitor_edge")
      .upsert(
        {
          workspace_id: workspaceId,
          competitor_id: compId,
          relation,
          tier,
          score: s.score,
          score_components: s.components,
          rationale: `${like}${s.cand.distanceKm ?? "?"}km away · ${s.cand.category ?? vertical}`,
        },
        { onConflict: "workspace_id,competitor_id" },
      )
      .select("id")
      .single();
    if (error) continue;
    rows.push({
      edgeId: data.id as string,
      businessId: compId,
      name: s.cand.name,
      website: originOf(s.cand.website),
      distanceKm: s.cand.distanceKm,
      relation,
      score: s.score,
    });
  }
  return rows;
}

/** Manually add a competitor by picked candidate (from search). */
export async function addCompetitor(
  workspaceId: string,
  target: { businessId: string; geo?: { lat: number; lng: number }; category?: string; subtype?: string[] },
  cand: { name: string; website?: string; geo?: { lat: number; lng: number }; category?: string; raw?: any },
  vertical: string = "restaurant",
): Promise<CompetitorRow> {
  const svc = createServiceClient();
  const compId = await upsertBusiness(svc, cand, vertical);
  const radiusKm = 5;
  const withDist =
    target.geo && cand.geo
      ? { ...cand, distanceKm: haversineKm(target.geo, cand.geo) }
      : { ...cand, distanceKm: undefined };
  const { score, components } = scoreCompetitor(
    { category: target.category, subtype: target.subtype },
    { ...(withDist as any), prominence: 0.3, platform: "manual" },
    radiusKm,
  );
  const { data, error } = await svc
    .from("competitor_edge")
    .upsert(
      {
        workspace_id: workspaceId,
        competitor_id: compId,
        relation: "primary",
        tier: "priority",
        score,
        score_components: { ...components, manual: true },
        rationale: "Added manually",
      },
      { onConflict: "workspace_id,competitor_id" },
    )
    .select("id")
    .single();
  if (error) throw new Error(`add competitor: ${error.message}`);
  return {
    edgeId: data.id as string,
    businessId: compId,
    name: cand.name,
    website: originOf(cand.website),
    distanceKm: (withDist as any).distanceKm,
    relation: "primary",
    score,
  };
}

function haversineKm(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
  const R = 6371;
  const dLat = ((b.lat - a.lat) * Math.PI) / 180;
  const dLng = ((b.lng - a.lng) * Math.PI) / 180;
  const la1 = (a.lat * Math.PI) / 180;
  const la2 = (b.lat * Math.PI) / 180;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(la1) * Math.cos(la2) * Math.sin(dLng / 2) ** 2;
  return Number((2 * R * Math.asin(Math.sqrt(h))).toFixed(2));
}
