import { createServiceClient } from "@/lib/supabase/server";
import { discoverCandidates } from "@/lib/providers/registry";
import type { ProfileCandidate } from "@/lib/providers/types";
import { extractSubtype, subtypeSimilarity, extractFormat, formatSimilarity, inferVertical, structuredVertical, isNonFood, verticalQuery, type Vertical } from "@/lib/classify";

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
  geo?: { lat: number; lng: number };
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

/** True when a "name" is really a bare domain/URL (e.g. "desicircleusa.com",
 *  "https://x.co") — a bad canonical_name we should replace with a display name. */
function looksLikeDomain(name?: string | null): boolean {
  const n = (name ?? "").trim();
  if (!n) return false;
  return /^https?:\/\//i.test(n) || (/^[a-z0-9-]+(\.[a-z0-9-]+)+$/i.test(n) && !n.includes(" "));
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
  target: { category?: string; subtype?: string[]; format?: string[] },
  cand: ProfileCandidate,
  radiusKm: number,
): { score: number; components: Record<string, unknown> } {
  const geoOverlap = cand.distanceKm != null ? 1 - Math.min(cand.distanceKm / radiusKm, 1) : 0.5;
  const categorySim = jaccard(tokens(target.category), tokens(cand.category)) || 0.4;
  const prominence = Math.max(0, Math.min(1, cand.prominence ?? 0));

  // Subtype (cuisine/ethnicity) similarity — the "like-for-like" cuisine signal.
  const targetSubtype = target.subtype ?? [];
  const candSubtype = extractSubtype(cand as any);
  const hasSubtype = targetSubtype.length > 0;
  const subtypeSim = hasSubtype ? subtypeSimilarity(targetSubtype, candSubtype) : 0;

  // Format (service-model) similarity — an ice-cream shop's rivals are dessert
  // places, a truck's are trucks. Weighted whenever the TARGET is a specialized
  // format: a same-vertical candidate with no/other format then scores 0 on this
  // axis, so a nearby popular taco place ranks below the real dessert rivals. A
  // plain restaurant (no format) skips this axis, so nothing is penalized.
  const targetFormat = target.format ?? [];
  const candFormat = extractFormat(cand as any);
  const hasFormat = targetFormat.length > 0;
  const formatSim = hasFormat ? formatSimilarity(targetFormat, candFormat) : 0;

  // Weights re-normalize over whichever like-for-like signals we actually have,
  // so a generic business isn't penalized for lacking a cuisine or a format.
  let score: number;
  if (hasSubtype && hasFormat) {
    score = 0.28 * subtypeSim + 0.15 * formatSim + 0.3 * geoOverlap + 0.12 * categorySim + 0.15 * prominence;
  } else if (hasSubtype) {
    score = 0.34 * subtypeSim + 0.33 * geoOverlap + 0.13 * categorySim + 0.2 * prominence;
  } else if (hasFormat) {
    score = 0.3 * formatSim + 0.4 * geoOverlap + 0.15 * categorySim + 0.15 * prominence;
  } else {
    score = 0.45 * geoOverlap + 0.3 * categorySim + 0.25 * prominence;
  }
  return {
    score: Number(score.toFixed(4)),
    components: {
      subtype_similarity: hasSubtype ? Number(subtypeSim.toFixed(3)) : null,
      subtype_matched: hasSubtype ? candSubtype.filter((s) => targetSubtype.includes(s)) : [],
      format_similarity: hasFormat ? Number(formatSim.toFixed(3)) : null,
      format_matched: hasFormat ? candFormat.filter((f) => targetFormat.includes(f)) : [],
      geo_overlap: Number(geoOverlap.toFixed(3)),
      category_similarity: Number(categorySim.toFixed(3)),
      prominence: Number(prominence.toFixed(3)),
      offering_similarity: null, // pending collection
      price_tier_similarity: null,
      audience_similarity: null,
      note: "onboarding v3: like-for-like cuisine + format + geo + category + prominence; offering/price/audience fill after collection",
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
  const address = cand.raw?.address
    ? Object.values(cand.raw.address).filter(Boolean).join(", ")
    : undefined;
  const subtype = extractSubtype(cand as any);
  const format = extractFormat(cand as any);

  const SEL = "id, canonical_name, attributes";
  let existing: { id: string; canonical_name: string | null; attributes: any } | null = null;
  if (website) {
    const { data } = await svc.from("business").select(SEL).eq("website", website).limit(1).maybeSingle();
    existing = (data as any) ?? null;
  }
  if (!existing) {
    const { data } = await svc
      .from("business")
      .select(SEL)
      .ilike("canonical_name", cand.name)
      .eq("vertical", vertical)
      .limit(1)
      .maybeSingle();
    existing = (data as any) ?? null;
  }

  let businessId = existing?.id;
  if (!businessId) {
    // Store lat/lng in attributes (avoids PostGIS WKT-cast issues over PostgREST;
    // the geography column can be backfilled by a worker later).
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
          ...(format.length ? { format } : {}),
        },
      })
      .select("id")
      .single();
    if (error) throw new Error(`business insert: ${error.message}`);
    businessId = data.id as string;
  } else if (existing) {
    // Backfill an EXISTING business (matched by website) with anything richer
    // this candidate carries. upsertBusiness historically only set these on
    // insert, so a business first created by another flow (e.g. named after its
    // domain, or with no geo) stayed broken forever. Fill only what's missing —
    // never overwrite a good value.
    const attrs = (existing.attributes as any) ?? {};
    const nextAttrs = { ...attrs };
    let dirty = false;
    if (cand.geo && !attrs.geo) { nextAttrs.geo = cand.geo; dirty = true; }
    if (address && !attrs.address) { nextAttrs.address = address; dirty = true; }
    if (subtype.length && !(attrs.subtype?.length)) { nextAttrs.subtype = subtype; dirty = true; }
    if (format.length && !(attrs.format?.length)) { nextAttrs.format = format; dirty = true; }

    const patch: Record<string, unknown> = {};
    if (dirty) patch.attributes = nextAttrs;
    // Replace a domain-ish stored name ("desicircleusa.com") with a real display
    // name when this candidate has one.
    if (looksLikeDomain(existing.canonical_name) && !looksLikeDomain(cand.name) && cand.name.trim())
      patch.canonical_name = cand.name.trim();

    if (Object.keys(patch).length) await svc.from("business").update(patch).eq("id", businessId);
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
    ["contact:tiktok", "tiktok"],
    ["contact:youtube", "youtube"],
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
  const sigsByName = new Map<string, Set<Vertical>>();
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
      // Drop clearly off-vertical retail/service (clothing, bank…) — but keep
      // anything that classifies to a vertical we *do* support (a beauty_salon /
      // spa now resolves to the salon vertical, so it must survive the filter).
      if (isNonFood(c as any) && structuredVertical(c as any) === null) return false;
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
  target: { businessId: string; name: string; geo?: { lat: number; lng: number }; category?: string; subtype?: string[]; format?: string[] },
  opts: { radiusKm?: number; limit?: number; vertical?: string } = {},
): Promise<CompetitorRow[]> {
  if (!target.geo) return [];
  const geo = target.geo;
  const baseRadius = opts.radiusKm ?? 6;
  const limit = opts.limit ?? 12;
  const vertical = opts.vertical ?? "restaurant";
  const svc = createServiceClient();

  // Target subtype (cuisine) + format (service-model) drive the like-for-like
  // discovery query + ranking. Fall back to the stored attributes, then to the
  // name, if the caller didn't pass them.
  let subtype = target.subtype ?? [];
  let format = target.format ?? [];
  if (!subtype.length || !format.length) {
    const { data: tb } = await svc.from("business").select("attributes").eq("id", target.businessId).maybeSingle();
    const a = (tb?.attributes as any) ?? {};
    if (!subtype.length) subtype = (a.subtype as string[]) ?? [];
    if (!format.length) format = (a.format as string[]) ?? [];
  }
  if (!format.length) format = extractFormat({ name: target.name });

  // One discovery pass at a given radius. Google Places now runs for food too
  // (verticalQuery returns a real query), so recall is far better than the old
  // OSM-only pass. Prefill distance for candidates that lack it (Google carries
  // geo but not distanceKm) so geo scoring works for every source.
  const gather = async (radiusKm: number) => {
    const raw = await discoverCandidates({
      query: verticalQuery(vertical, subtype, format),
      near: { ...geo, radiusKm },
      vertical,
      limit: 40,
      subtypeTerms: subtype,
    });
    return raw.map((c) => ({
      ...c,
      distanceKm: c.distanceKm ?? (c.geo ? Number(haversineKm(geo, c.geo).toFixed(2)) : undefined),
    }));
  };

  // How many like-for-like (same cuisine OR same format) rivals a list holds.
  const likeCount = (list: ProfileCandidate[]) =>
    list.filter(
      (c) =>
        inferVertical(c as any) === vertical &&
        (subtypeSimilarity(subtype, extractSubtype(c as any)) > 0 ||
          formatSimilarity(format, extractFormat(c as any)) > 0),
    ).length;

  let cands = await gather(baseRadius);
  // Recall expansion: if the neighbourhood is sparse on like-for-like rivals
  // (spread-out suburbs like Cedar Park), widen the net once and merge by name.
  if ((subtype.length || format.length) && likeCount(cands) < Math.min(limit, 8)) {
    const more = await gather(baseRadius * 2);
    const byName = new Map(cands.map((c) => [c.name.toLowerCase().trim(), c]));
    for (const c of more) {
      const k = c.name.toLowerCase().trim();
      if (!byName.has(k)) byName.set(k, c);
    }
    cands = [...byName.values()];
  }

  const targetName = target.name.toLowerCase().trim();

  // Vertical consistency: the like-for-like passes are free-text and can pull in
  // same-cuisine businesses of another vertical; keep only candidates whose own
  // type matches the target vertical (a restaurant's rivals are restaurants).
  const scored = cands
    .filter((c) => c.name.toLowerCase().trim() !== targetName)
    .filter((c) => inferVertical(c as any) === vertical)
    .map((c) => ({ cand: c, ...scoreCompetitor({ category: target.category, subtype, format }, c, baseRadius) }))
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
    const fmt = (s.components as any).format_matched as string[] | undefined;
    const tags = [...(matched ?? []), ...(fmt ?? [])];
    const like = tags.length ? `same type (${tags.join(", ").replace(/_/g, " ")}) · ` : "";
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
      geo: s.cand.geo,
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
  target: { businessId: string; geo?: { lat: number; lng: number }; category?: string; subtype?: string[]; format?: string[] },
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
    { category: target.category, subtype: target.subtype, format: target.format },
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
    geo: cand.geo,
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
