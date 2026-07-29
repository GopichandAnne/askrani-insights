import { createServiceClient } from "@/lib/supabase/server";
import type { PipelineOffer } from "@/lib/extraction/pipeline";
import type { Recommendation } from "@/lib/recommend/engine";

/**
 * Persist an onboarding analysis into the canonical data model.
 *
 * Runs with the service-role client. Public market rows (business, content_item,
 * offer) are written globally per guide 8.2 ("public observations may be shared
 * globally"); tenant-owned rows (workspace, competitor_edge, recommendation) are
 * scoped to the org id, which the caller resolves from the *verified* auth user
 * — never from client input.
 *
 * Append-only where the schema is history-preserving: each save inserts fresh
 * offers (a price/menu observation in time) and refreshes only the still-open
 * 'proposed' recommendations, leaving accepted/dismissed ones intact.
 */

interface AnalyzedInput {
  name: string;
  url: string;
  offers: PipelineOffer[];
}

export interface PersistInput {
  orgId: string;
  target: AnalyzedInput;
  competitors: AnalyzedInput[];
  recommendations: Recommendation[];
}

export interface PersistResult {
  workspaceId: string;
  targetBusinessId: string;
  offersWritten: number;
  competitorsLinked: number;
  recommendationsWritten: number;
}

function originOf(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return url;
  }
}

export async function persistAnalysis(input: PersistInput): Promise<PersistResult> {
  const svc = createServiceClient();
  const nowIso = new Date().toISOString();

  async function upsertBusiness(name: string, url: string): Promise<string> {
    const website = originOf(url);
    const { data: existing } = await svc
      .from("business")
      .select("id")
      .eq("website", website)
      .limit(1)
      .maybeSingle();
    if (existing?.id) return existing.id as string;

    const { data, error } = await svc
      .from("business")
      .insert({
        canonical_name: name || website,
        website,
        vertical: "restaurant",
        category: "restaurant",
        confidence: 0.7,
      })
      .select("id")
      .single();
    if (error) throw new Error(`business upsert: ${error.message}`);

    // record the website as an external identity for the business graph
    await svc.from("external_identity").insert({
      business_id: data.id,
      platform: "website",
      url: website,
      verification_state: "observed",
    });
    return data.id as string;
  }

  // one content_item per site (upsert by platform+url); offers link to it so
  // every offer traces to a source (Appendix D acceptance criterion).
  async function upsertSiteContentItem(businessId: string, url: string): Promise<string> {
    const website = originOf(url);
    const { data, error } = await svc
      .from("content_item")
      .upsert(
        {
          business_id: businessId,
          platform: "website",
          external_ref: website,
          provenance: "PUBLIC_WEBSITE_HTTP",
          url: website,
          observed_at: nowIso,
        },
        { onConflict: "platform,external_ref" },
      )
      .select("id")
      .single();
    if (error) throw new Error(`content_item upsert: ${error.message}`);
    return data.id as string;
  }

  async function insertOffers(
    businessId: string,
    contentItemId: string,
    offers: PipelineOffer[],
  ): Promise<number> {
    if (!offers.length) return 0;
    const rows = offers.map((o) => ({
      business_id: businessId,
      content_item_id: contentItemId,
      entity_text: o.entity_text,
      offer_type: o.offer_type,
      pricing: o.pricing,
      conditions: o.conditions ?? [],
      validity_start: o.validity_start,
      validity_end: o.validity_end,
      confidence: o.confidence,
      provenance: o.provenance,
      observed_at: nowIso,
      valid_from: nowIso,
    }));
    const { error } = await svc.from("offer").insert(rows);
    if (error) throw new Error(`offers insert: ${error.message}`);
    return rows.length;
  }

  // ── target business + workspace ──────────────────────────────────────────
  const targetBusinessId = await upsertBusiness(input.target.name, input.target.url);

  const { data: existingWs } = await svc
    .from("workspace")
    .select("id")
    .eq("organization_id", input.orgId)
    .eq("target_business_id", targetBusinessId)
    .limit(1)
    .maybeSingle();

  let workspaceId: string;
  if (existingWs?.id) {
    workspaceId = existingWs.id as string;
  } else {
    const { data, error } = await svc
      .from("workspace")
      .insert({
        organization_id: input.orgId,
        name: input.target.name || originOf(input.target.url),
        vertical: "restaurant",
        target_business_id: targetBusinessId,
      })
      .select("id")
      .single();
    if (error) throw new Error(`workspace insert: ${error.message}`);
    workspaceId = data.id as string;
  }

  let offersWritten = 0;
  const targetCi = await upsertSiteContentItem(targetBusinessId, input.target.url);
  offersWritten += await insertOffers(targetBusinessId, targetCi, input.target.offers);

  // ── competitors ──────────────────────────────────────────────────────────
  let competitorsLinked = 0;
  for (const comp of input.competitors) {
    const compId = await upsertBusiness(comp.name, comp.url);
    if (compId === targetBusinessId) continue;
    const ci = await upsertSiteContentItem(compId, comp.url);
    offersWritten += await insertOffers(compId, ci, comp.offers);

    const overlap = offerOverlap(input.target.offers, comp.offers);
    const { error } = await svc.from("competitor_edge").upsert(
      {
        workspace_id: workspaceId,
        competitor_id: compId,
        relation: "secondary",
        tier: "standard",
        score: overlap,
        score_components: {
          offering_similarity: overlap,
          note: "onboarding v1: menu/offer name overlap only; geo/price/audience pending",
        },
        rationale: `Selected during onboarding; ${comp.offers.length} offers observed`,
      },
      { onConflict: "workspace_id,competitor_id" },
    );
    if (error) throw new Error(`competitor_edge upsert: ${error.message}`);
    competitorsLinked++;
  }

  // ── recommendations (refresh open 'proposed' only) ───────────────────────
  await svc
    .from("recommendation")
    .delete()
    .eq("workspace_id", workspaceId)
    .eq("status", "proposed");

  let recommendationsWritten = 0;
  if (input.recommendations.length) {
    const rows = input.recommendations.map((r) => ({
      workspace_id: workspaceId,
      category: r.category,
      title: r.title,
      action: r.action,
      why_now: r.why_now,
      expected_impact: r.expected_impact,
      effort: r.effort,
      urgency: r.urgency,
      priority: r.priority,
      experiment: null,
      status: "proposed",
    }));
    const { error } = await svc.from("recommendation").insert(rows);
    if (error) throw new Error(`recommendation insert: ${error.message}`);
    recommendationsWritten = rows.length;
  }

  return {
    workspaceId,
    targetBusinessId,
    offersWritten,
    competitorsLinked,
    recommendationsWritten,
  };
}

function offerOverlap(a: PipelineOffer[], b: PipelineOffer[]): number {
  if (!a.length || !b.length) return 0;
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9 ]/g, "").trim();
  const setA = new Set(a.map((o) => norm(o.entity_text)));
  const inter = b.filter((o) => setA.has(norm(o.entity_text))).length;
  return Number((inter / Math.max(a.length, b.length)).toFixed(4));
}
