import { createServiceClient } from "@/lib/supabase/server";
import { discoverCandidates } from "@/lib/providers/registry";
import type { ProfileCandidate } from "@/lib/providers/types";
import { extractSubtype, subtypeSimilarity, extractFormat, formatSimilarity, inferVertical, structuredVertical, isNonFood, verticalQuery, type Vertical } from "@/lib/classify";
import { getVerticalProfile } from "@/lib/verticalprofile";
import { getLlm, isLlmConfigured } from "@/lib/extraction/llm";

/**
 * Competitor DIMENSION CLASSIFIER — the model's job is semantic judgment on named
 * dimensions, NOT a single blended number. For each candidate it rates the overlaps
 * a real substitution decision turns on (cuisine/product, format, occasion/daypart,
 * customer), classifies the RELATIONSHIP (direct / occasion / inspiration /
 * not_competitor), and gives its evidence. Deterministic code then turns those
 * dimensions into the similarity score (vertical-weighted) — so scoring is auditable
 * and the weights can later be learned from owner labels. Returns null if the LLM is
 * off (caller falls back to the deterministic pureSimilarity).
 */
export type CompRelationship = "direct" | "occasion" | "inspiration" | "not_competitor";
export interface CandClassification {
  cuisine: number; format: number; occasion: number; customer: number;
  relationship: CompRelationship; reason: string;
}
export async function llmCompetitorClassify(
  target: { name: string; vertical: string; category?: string; subtype?: string[] },
  cands: { name: string; category?: string; distanceKm?: number; subtype?: string[]; scale?: string }[],
): Promise<Map<number, CandClassification> | null> {
  if (!isLlmConfigured() || !cands.length) return null;
  const list = cands
    .map((c, i) => `[${i}] ${c.name}${c.category ? ` — ${c.category}` : ""}${c.subtype?.length ? ` [${c.subtype.join("/")}]` : ""}${c.distanceKm != null ? ` · ${c.distanceKm}km` : ""}${c.scale ? ` · ${c.scale}` : ""}`)
    .join("\n");
  const dim = (desc: string) => ({ type: "number", description: desc });
  const SCHEMA = {
    type: "object", additionalProperties: false,
    properties: {
      scores: {
        type: "array",
        items: {
          type: "object", additionalProperties: false,
          properties: {
            i: { type: "integer", description: "the candidate's [index]" },
            cuisine: dim("0..1 overlap of specialty — cuisine for restaurants, product focus for grocery, service line for salons. A different specialty in the same category is LOW (~0.3)."),
            format: dim("0..1 overlap of format/service model (fast-casual vs fine-dining, truck, buffet, delivery-first, store size)."),
            occasion: dim("0..1 overlap of the purchase OCCASION/daypart they win (weekday lunch, family dinner, late-night, catering, quick delivery)."),
            customer: dim("0..1 overlap of the actual customers/community they serve."),
            relationship: { type: "string", enum: ["direct", "occasion", "inspiration", "not_competitor"], description: "direct = customers choose between them; occasion = different specialty but competes for the same occasion; inspiration = admirable but not a local substitute; not_competitor = neither." },
            reason: { type: "string", description: "≤12 words of evidence." },
          },
          required: ["i", "cuisine", "format", "occasion", "customer", "relationship"],
        },
      },
    },
    required: ["scores"],
  };
  const SYSTEM =
    "You classify how each nearby business competes with a given LOCAL business. For each candidate rate four 0..1 overlaps — cuisine/product, format, occasion/daypart, customer — and set the relationship. Judge SPECIALTY FIRST: a different specialty in the same broad category means LOW cuisine overlap (an Indian/desi grocery vs a Korean or general supermarket ~0.3), even next door. Two businesses can have low cuisine overlap yet high OCCASION overlap (both win the weekday lunch-under-$15 crowd) — capture that in the occasion dimension and relationship='occasion'. DISCOUNT large national chains for a local business. Mark far-away or aspirational businesses 'inspiration', and unrelated ones 'not_competitor'. Ground every rating in the specialty/scale shown. Classify EVERY candidate by its [index].";
  try {
    const { data } = await getLlm().callStructured<{ scores: unknown }>({
      system: SYSTEM,
      text: `Owner's business: "${target.name}" — ${target.vertical}${target.category ? ` (${target.category})` : ""}${target.subtype?.length ? `, specialty: ${target.subtype.join("/")}` : ""}.\n\nNearby candidates (same vertical):\n${list}\n\nClassify each candidate.`,
      schema: SCHEMA, tier: "classify", maxTokens: 2600,
    });
    let rows: any[] = Array.isArray((data as any).scores) ? (data as any).scores : [];
    if (!rows.length && typeof (data as any).scores === "string") {
      try { const p = JSON.parse((data as any).scores); rows = Array.isArray(p) ? p : Array.isArray(p?.scores) ? p.scores : []; } catch { /* not JSON */ }
    }
    if (!rows.length) return null;
    const clamp01 = (n: unknown) => Math.max(0, Math.min(1, Number(n)));
    const RELS = new Set<CompRelationship>(["direct", "occasion", "inspiration", "not_competitor"]);
    const m = new Map<number, CandClassification>();
    for (const r of rows) {
      const i = Number(r.i);
      if (!Number.isInteger(i)) continue;
      const relationship = RELS.has(r.relationship) ? (r.relationship as CompRelationship) : "direct";
      m.set(i, {
        cuisine: clamp01(r.cuisine), format: clamp01(r.format), occasion: clamp01(r.occasion), customer: clamp01(r.customer),
        relationship, reason: String(r.reason ?? "").replace(/\s+/g, " ").trim().slice(0, 140),
      });
    }
    return m.size ? m : null;
  } catch {
    return null;
  }
}

/** Turn the classifier's dimension overlaps into a similarity score — vertical-
 *  weighted, so competition semantics differ by vertical even though the infra
 *  doesn't. Price folds in post-collection (Phase 2). */
export function similarityFromDims(vertical: string, d: CandClassification): number {
  const s = vertical === "grocery"
    ? 0.45 * d.cuisine + 0.25 * d.customer + 0.20 * d.format + 0.10 * d.occasion
    : 0.45 * d.cuisine + 0.20 * d.format + 0.20 * d.occasion + 0.15 * d.customer;
  return Math.max(0, Math.min(1, s));
}

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

/**
 * Pure SIMILARITY (substitutability) — how interchangeable two businesses are,
 * with NO geo or prominence mixed in (those belong to THREAT, not similarity).
 * The deterministic counterpart to the LLM's like-for-like relevance, used when
 * the model is unavailable. Renormalizes over whichever specialty signals exist.
 */
export function pureSimilarity(
  target: { category?: string; subtype?: string[]; format?: string[] },
  cand: ProfileCandidate,
): { similarity: number; components: Record<string, unknown> } {
  const categorySim = jaccard(tokens(target.category), tokens(cand.category)) || 0.4;
  const targetSubtype = target.subtype ?? [];
  const candSubtype = extractSubtype(cand as any);
  const hasSubtype = targetSubtype.length > 0;
  const subtypeSim = hasSubtype ? subtypeSimilarity(targetSubtype, candSubtype) : 0;
  const targetFormat = target.format ?? [];
  const candFormat = extractFormat(cand as any);
  const hasFormat = targetFormat.length > 0;
  const formatSim = hasFormat ? formatSimilarity(targetFormat, candFormat) : 0;

  let similarity: number;
  if (hasSubtype && hasFormat) similarity = 0.55 * subtypeSim + 0.25 * formatSim + 0.20 * categorySim;
  else if (hasSubtype) similarity = 0.70 * subtypeSim + 0.30 * categorySim;
  else if (hasFormat) similarity = 0.60 * formatSim + 0.40 * categorySim;
  else similarity = categorySim;

  return {
    similarity,
    components: {
      subtype_similarity: hasSubtype ? Number(subtypeSim.toFixed(3)) : null,
      subtype_matched: hasSubtype ? candSubtype.filter((s) => targetSubtype.includes(s)) : [],
      format_similarity: hasFormat ? Number(formatSim.toFixed(3)) : null,
      format_matched: hasFormat ? candFormat.filter((f) => targetFormat.includes(f)) : [],
      category_similarity: Number(categorySim.toFixed(3)),
    },
  };
}

/**
 * THREAT — how much this business should actually worry about a competitor NOW.
 * A rival is only a threat to the extent it's substitutable (similarity) AND
 * reachable in the trade area (geo) AND has local presence (prominence). So a
 * highly-similar chain 11mi away scores lower than a similar rival next door, and
 * a non-similar business is never a big threat however close/popular. Momentum &
 * promo-aggression fold in post-collection.
 */
export function threatScore(similarity: number, geoOverlap: number, prominence: number): number {
  return Number((similarity * (0.30 + 0.50 * geoOverlap + 0.20 * prominence)).toFixed(4));
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

  // Google Place ID (candidates from the google provider carry it on raw.id) — a
  // strong identity key: two records for the SAME place must dedup to one, even
  // when their names/websites differ (e.g. a real grocery vs a DoorDash ghost
  // listing at the same address).
  const placeId = typeof cand.raw?.id === "string" ? (cand.raw.id as string) : undefined;

  const SEL = "id, canonical_name, attributes";
  let existing: { id: string; canonical_name: string | null; attributes: any } | null = null;
  if (placeId) {
    const { data } = await svc.from("business").select(SEL).filter("attributes->>place_id", "eq", placeId).limit(1).maybeSingle();
    existing = (data as any) ?? null;
  }
  if (!existing && website) {
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
          ...(placeId ? { place_id: placeId } : {}),
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

/**
 * Create an AREA workspace — a monitored zip/location with NO target business.
 * The watched set is the businesses Explore already found there; each is stored
 * as a peer competitor_edge (none is "you"). Subject metadata lives in
 * goals.subjectType/subject (see lib/subject.ts). Idempotent-ish: callers make a
 * fresh area workspace per monitor action; de-duping is left to the caller.
 */
export async function createAreaWorkspace(
  orgId: string,
  input: {
    area: string;
    keyword?: string | null;
    vertical?: string;
    center?: { lat: number; lng: number } | null;
    businesses: { name: string; website?: string; geo?: { lat: number; lng: number }; category?: string; vertical?: string }[];
  },
): Promise<{ workspaceId: string; count: number }> {
  const svc = createServiceClient();
  const vertical = input.vertical || "restaurant";
  const what = input.keyword ? input.keyword.replace(/\b\w/g, (c) => c.toUpperCase()) : "Businesses";
  const name = `${what} · ${input.area}`;

  const { data, error } = await svc
    .from("workspace")
    .insert({
      organization_id: orgId,
      name,
      vertical,
      target_business_id: null,
      goals: {
        subjectType: "area",
        subject: { area: input.area, keyword: input.keyword ?? null, center: input.center ?? null },
      },
    })
    .select("id")
    .single();
  if (error) throw new Error(`area workspace insert: ${error.message}`);
  const workspaceId = data.id as string;

  // Persist each found business + attach it to the workspace as a peer edge.
  let count = 0;
  for (const b of input.businesses.slice(0, 15)) {
    if (!b.name) continue;
    const compId = await upsertBusiness(svc, b, b.vertical || vertical);
    const { error: edgeErr } = await svc
      .from("competitor_edge")
      .upsert(
        {
          workspace_id: workspaceId,
          competitor_id: compId,
          relation: "primary",
          tier: "standard",
          score: 0.5,
          score_components: { area: true },
          rationale: "In the monitored area",
        },
        { onConflict: "workspace_id,competitor_id" },
      );
    if (!edgeErr) count++;
  }
  return { workspaceId, count };
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

  // The competitor-discovery search phrase: a curated, cuisine-aware query for the
  // hand-tuned verticals; for anything else (e.g. 'other', a novel type) an
  // LLM-derived phrase, cached per vertical. So recall stays sharp for every kind
  // of business, not just the ones we hardcoded.
  // For the catch-all 'other' bucket, key the LLM profile on the real Google
  // category (e.g. car_repair, lawyer) — all novel types collapse to 'other', so
  // 'other' itself is a useless generation/cache key.
  const profileKey = vertical === "other" && target.category ? target.category : vertical;
  const discoveryQuery = verticalQuery(vertical, subtype, format)
    ?? (await getVerticalProfile(svc, profileKey))?.discovery_query
    ?? undefined;

  // One discovery pass at a given radius. Prefill distance for candidates that
  // lack it (Google carries geo but not distanceKm) so geo scoring works for
  // every source.
  const gather = async (radiusKm: number) => {
    const raw = await discoverCandidates({
      query: discoveryQuery,
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

  // Candidate-generation expansion (Phase 1b): the vertical query finds direct
  // look-alikes, but occasion/delivery rivals surface under how CUSTOMERS search —
  // and the ranker can never pick a competitor discovery never found. Add a couple of
  // bounded intent passes for food verticals and union them in; the classifier then
  // sorts direct vs occasion.
  if (vertical === "restaurant" || vertical === "grocery") {
    const cuisine = subtype[0];
    const intents = (vertical === "restaurant"
      ? [cuisine ? `${cuisine} delivery` : null, cuisine ? `${cuisine} lunch` : "lunch near me"]
      : [cuisine ? `${cuisine} grocery delivery` : null, "grocery delivery"]
    ).filter(Boolean) as string[];
    const byName = new Map(cands.map((c) => [c.name.toLowerCase().trim(), c]));
    for (const q of intents.slice(0, 2)) {
      try {
        const extra = await discoverCandidates({ query: q, near: { ...geo, radiusKm: baseRadius }, vertical, limit: 20 });
        for (const c of extra) {
          const k = c.name.toLowerCase().trim();
          if (byName.has(k)) continue;
          byName.set(k, { ...c, distanceKm: c.distanceKm ?? (c.geo ? Number(haversineKm(geo, c.geo).toFixed(2)) : undefined) });
        }
      } catch { /* best-effort recall */ }
    }
    cands = [...byName.values()];
  }

  const targetName = target.name.toLowerCase().trim();

  // Vertical consistency: the like-for-like passes are free-text and can pull in
  // same-cuisine businesses of another vertical; keep only candidates whose own
  // type matches the target vertical (a restaurant's rivals are restaurants).
  // A business isn't its own competitor: drop the target and its name-variants
  // (Google/OSM list "Man Pasand Supermarket" separately from "Manpasand …
  // Supermarket" — a near-name match at ~the same spot is the target itself).
  const isSelf = (c: ProfileCandidate) => {
    if (c.name.toLowerCase().trim() === targetName) return true;
    return c.distanceKm != null && c.distanceKm < 0.3 && nameRelevance(target.name, c.name) >= 0.55;
  };
  const filtered = cands
    .filter((c) => !isSelf(c))
    .filter((c) => inferVertical(c as any) === vertical);

  // A coarse scale hint from normalized review-volume (prominence is relative to the
  // biggest in this candidate set), so the ranker can spot likely large/chain rivals.
  const scaleHint = (p?: number): string => {
    const v = Math.max(0, Math.min(1, p ?? 0));
    return v >= 0.6 ? "very high review volume (likely large/chain)" : v >= 0.25 ? "moderate review volume" : "low review volume (small/local)";
  };

  // The model classifies each candidate on named dimensions + relationship; code
  // scores. Falls back to the deterministic pureSimilarity when the LLM is off.
  const cls = await llmCompetitorClassify(
    { name: target.name, vertical, category: target.category, subtype },
    filtered.map((c) => ({ name: c.name, category: c.category, distanceKm: c.distanceKm, subtype: extractSubtype(c as any), scale: scaleHint(c.prominence) })),
  );
  // Two scores per candidate, not one: SIMILARITY (how substitutable) and THREAT
  // (how much to worry now = similarity × proximity × presence), plus the RELATIONSHIP
  // (direct vs occasion). inspiration / not_competitor are dropped from the set.
  type Scored = { cand: ProfileCandidate; similarity: number; threat: number; score: number; relationship: CompRelationship; components: Record<string, unknown> };
  const scoredAll = filtered
    .map((c, i): Scored | null => {
      const geoOverlap = c.distanceKm != null ? 1 - Math.min(c.distanceKm / baseRadius, 1) : 0.5;
      const prominence = Math.max(0, Math.min(1, c.prominence ?? 0));
      let similarity: number;
      let relationship: CompRelationship = "direct";
      let base: Record<string, unknown>;
      if (cls) {
        const d = cls.get(i);
        if (!d || d.relationship === "not_competitor" || d.relationship === "inspiration") return null; // not a monitored rival
        similarity = similarityFromDims(vertical, d);
        relationship = d.relationship;
        base = { cuisine_overlap: Number(d.cuisine.toFixed(3)), format_overlap: Number(d.format.toFixed(3)), occasion_overlap: Number(d.occasion.toFixed(3)), customer_overlap: Number(d.customer.toFixed(3)), relationship, rationale: d.reason };
      } else {
        const det = pureSimilarity({ category: target.category, subtype, format }, c);
        similarity = det.similarity;
        base = det.components;
      }
      const threat = threatScore(similarity, geoOverlap, prominence);
      return {
        cand: c,
        similarity: Number(similarity.toFixed(4)),
        threat,
        score: threat, // selection + edge.score = threat (who to monitor now)
        relationship,
        components: {
          ...base,
          similarity: Number(similarity.toFixed(3)),
          threat,
          geo_overlap: Number(geoOverlap.toFixed(3)),
          prominence: Number(prominence.toFixed(3)),
          note: "discovery v7: dimension classifier → similarity + threat; relationship-aware; price folds in post-collection",
        } as Record<string, unknown>,
      };
    })
    .filter((s): s is Scored => s !== null)
    .sort((a, b) => b.threat - a.threat);

  // Dedup near-identical names (Google + OSM list the same store twice), keeping the
  // highest-threat copy.
  const seenNames = new Set<string>();
  const deduped: typeof scoredAll = [];
  for (const s of scoredAll) {
    const k = s.cand.name.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
    if (!k || seenNames.has(k)) continue;
    seenNames.add(k);
    deduped.push(s);
  }

  // Threshold + diversity, not a hard top-N: a rural business with 3 real rivals
  // shouldn't get 9 invented ones. Primary = a genuine threat AND substitutable;
  // secondary = meaningful overlap but weaker; everything below the floor is dropped.
  const PRIMARY_MAX = 7, SECONDARY_MAX = 10;
  const HARD_CAP = Math.max(opts.limit ?? 15, PRIMARY_MAX + 3);
  const primary: typeof deduped = [];
  const secondary: typeof deduped = [];
  for (const s of deduped) {
    if (primary.length + secondary.length >= HARD_CAP) break;
    // Only DIRECT substitutes can be primary; occasion competitors (same job, different
    // specialty) are meaningful but belong in secondary, not the head-to-head set.
    const canBePrimary = s.relationship !== "occasion";
    if (canBePrimary && primary.length < PRIMARY_MAX && s.threat >= 0.42 && s.similarity >= 0.5) primary.push(s);
    else if (secondary.length < SECONDARY_MAX && (s.threat >= 0.28 || s.similarity >= 0.55)) secondary.push(s);
  }
  // Sparse market: thresholds can leave nothing — never show an empty market when
  // real candidates exist, so promote the top few by threat into primary.
  if (!primary.length && deduped.length) {
    const top = deduped.slice(0, Math.min(3, deduped.length));
    primary.push(...top);
    for (const t of top) { const idx = secondary.indexOf(t); if (idx >= 0) secondary.splice(idx, 1); }
  }
  const chosen = [
    ...primary.map((s) => ({ s, relation: "primary" as const, tier: "priority" as const })),
    ...secondary.map((s) => ({ s, relation: "secondary" as const, tier: "standard" as const })),
  ];

  const rows: CompetitorRow[] = [];
  for (const { s, relation, tier } of chosen) {
    const compId = await upsertBusiness(
      svc,
      { name: s.cand.name, website: s.cand.website, geo: s.cand.geo, category: s.cand.category, raw: s.cand.raw },
      vertical,
    );
    if (compId === target.businessId) continue;
    const why = (s.components as any).rationale as string | undefined;
    const matched = (s.components as any).subtype_matched as string[] | undefined;
    const fmt = (s.components as any).format_matched as string[] | undefined;
    const tags = [...(matched ?? []), ...(fmt ?? [])];
    // prefer the model's like-for-like reason; fall back to the keyword "same type" label
    const like = why ? `${why} · ` : tags.length ? `same type (${tags.join(", ").replace(/_/g, " ")}) · ` : "";
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
