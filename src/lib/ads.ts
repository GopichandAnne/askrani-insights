import { createClient, createServiceClient, type RlsClient } from "@/lib/supabase/server";
import { workspaceBusinessIds, type WorkspaceRow } from "@/lib/workspace";
import { getLlm, isLlmConfigured } from "@/lib/extraction/llm";
import { collectApifyAdLibrary, adLibraryConfigured, type RivalAd } from "@/lib/providers/apify/platforms";

/**
 * "What rivals are paying to promote" — competitor ads from the Meta Ad Library.
 * Meta's official API only returns political/EU ads, so US commercial ads come
 * from scraping the Ad Library (Apify) — gated + cost-bearing, so this refreshes
 * on demand (never on render), keyed by each competitor's Facebook page/name.
 * The raw ads + a light LLM read (what offers/angles rivals push + your move) are
 * cached on workspace.goals.ads. Many local businesses run NO ads → often empty.
 */

export interface AdsReport {
  summary: string;
  ads: RivalAd[];                              // the raw active ads (deduped)
  patterns: { pattern: string; example?: string }[];
  moves: string[];
  advertisers: string[];                       // rivals found running ads
  at: string;
  empty?: boolean;
}

const strip = (s?: string) => String(s ?? "").replace(/<\/?[a-z][^>]*>/gi, "").replace(/\s+/g, " ").trim();
const fbSlug = (url?: string) => {
  if (!url) return undefined;
  const m = /facebook\.com\/([^/?#]+)/i.exec(url);
  const slug = m?.[1];
  return slug && !/^(pages|profile\.php|people)$/i.test(slug) ? slug.replace(/[-.]/g, " ") : undefined;
};
// A numeric Facebook page id, if the URL carries one (profile.php?id=123 or
// /pages/Name/123). Lets us scope the Ad Library to ONLY this advertiser — far
// cheaper than a keyword search that fans out across every matching brand.
const fbPageId = (url?: string): string | undefined => {
  if (!url) return undefined;
  const m = /[?&]id=(\d{5,})/.exec(url) ?? /\/pages\/[^/]+\/(\d{5,})/.exec(url) ?? /facebook\.com\/(\d{6,})(?:[/?#]|$)/.exec(url);
  return m?.[1];
};

const SCHEMA = {
  type: "object", additionalProperties: false,
  properties: {
    summary: { type: "string", description: "ONE sentence — what your rivals are pushing in paid ads right now." },
    patterns: {
      type: "array", maxItems: 6, description: "The recurring angles/offers across the ads (e.g. '$99 new-client Botox', 'free consult', 'weekend BOGO'). Ground in the ads.",
      items: { type: "object", additionalProperties: false, properties: { pattern: { type: "string" }, example: { type: "string", description: "a short real snippet from an ad" } }, required: ["pattern"] },
    },
    moves: { type: "array", maxItems: 4, items: { type: "string" }, description: "Concrete moves for THIS owner given what rivals are advertising (match an offer, counter-position, promote a differentiator)." },
  },
  required: ["summary", "patterns", "moves"],
};

const SYSTEM =
  "You are Ask Rani. From the competitor ADS below (real Meta Ad Library ads), tell a local-business owner what rivals are paying to promote — the offers, hooks and CTAs — and what to do about it. Ground everything in the ads; never invent an offer. Plain English.";

const empty = (at: string): AdsReport => ({ summary: "", ads: [], patterns: [], moves: [], advertisers: [], at, empty: true });

/** Scrape each competitor's active ads, synthesize, and cache. COST-BEARING —
 *  only called from the gated /api/ads/refresh endpoint, never on render. */
const ADS_FRESH_MS = 7 * 24 * 60 * 60 * 1000; // ads change weekly at most — don't re-scrape every collection cycle

export async function refreshCompetitorAds(
  ws: WorkspaceRow, opts: { maxCompetitors?: number; limitPerAdvertiser?: number; maxCostPerAdvertiserUsd?: number; force?: boolean } = {},
): Promise<{ activated: boolean; scraped: number; advertisers: number; costUsd: number }> {
  if (!adLibraryConfigured()) return { activated: false, scraped: 0, advertisers: 0, costUsd: 0 };
  const svc = createServiceClient();
  // Freshness guard: this is auto-called after EVERY collection cycle, but ads move
  // slowly and each scrape is metered — so skip when the cache is < 7 days old
  // (unless forced from the manual refresh button). This is the main frequency lever.
  if (!opts.force) {
    const { data: gRow } = await svc.from("workspace").select("goals").eq("id", ws.id).maybeSingle();
    const prevAt = (gRow?.goals as any)?.ads?.at as string | undefined;
    if (prevAt && Date.now() - new Date(prevAt).getTime() < ADS_FRESH_MS) {
      return { activated: true, scraped: 0, advertisers: 0, costUsd: 0 };
    }
  }
  const ids = await workspaceBusinessIds(ws, svc as unknown as RlsClient);
  const compIds = ids.competitorIds.slice(0, opts.maxCompetitors ?? 8);
  if (!compIds.length) return { activated: true, scraped: 0, advertisers: 0, costUsd: 0 };

  const [{ data: biz }, { data: idents }] = await Promise.all([
    svc.from("business").select("id, canonical_name, attributes").in("id", compIds),
    svc.from("external_identity").select("business_id, platform, url").in("business_id", compIds).eq("platform", "facebook"),
  ]);
  const fbByBiz = new Map<string, string>();
  for (const r of idents ?? []) if (!fbByBiz.has((r as any).business_id)) fbByBiz.set((r as any).business_id, (r as any).url);

  const toks = (s: string) => new Set(String(s).toLowerCase().replace(/[^a-z0-9\s]/g, " ").split(/\s+/).filter((t) => t.length > 2));
  const all: RivalAd[] = [];
  let costUsd = 0;
  for (const b of biz ?? []) {
    const name = String((b as any).canonical_name ?? "");
    const attrs = (((b as any).attributes ?? {}) as Record<string, any>);
    const fbUrl = fbByBiz.get((b as any).id);
    const query = fbSlug(fbUrl) ?? name;
    if (!query) continue;
    // Page-scope when we know the numeric page id (only THIS advertiser's ads, so
    // no truncation risk + cheap). Otherwise keyword search, which the collector
    // gives real headroom + a $ ceiling so we don't cut off the target's ads.
    const storedPageId = typeof attrs.fb_page_id === "string" ? attrs.fb_page_id : undefined;
    const { items, costUsd: c } = await collectApifyAdLibrary(query, {
      limit: opts.limitPerAdvertiser,
      pageId: storedPageId || fbPageId(fbUrl),
      maxCostUsd: opts.maxCostPerAdvertiserUsd,
    });
    costUsd += c;
    // Ad Library keyword search returns any advertiser matching the term, so keep
    // only ads whose advertiser actually overlaps this competitor's name (drops
    // unrelated brands the keyword happened to match — never the target's ads).
    const want = toks(name);
    const relevant = items.filter((ad) => { const adv = toks(ad.advertiser); return want.size === 0 || [...adv].some((t) => want.has(t)); });
    for (const ad of relevant) all.push({ ...ad, advertiser: ad.advertiser === "A rival" ? name : ad.advertiser });
    // Self-heal: learn this competitor's page id from a matched ad, so the NEXT
    // run page-scopes (exact + cheap) instead of the lossy keyword search.
    if (!storedPageId) {
      const pid = relevant.find((a) => a.pageId)?.pageId;
      if (pid) await svc.from("business").update({ attributes: { ...attrs, fb_page_id: pid } }).eq("id", (b as any).id).then(() => {}, () => {});
    }
  }
  // dedup by advertiser+text
  const seen = new Set<string>();
  const ads = all.filter((a) => { const k = `${a.advertiser}|${a.text.slice(0, 80)}`; if (seen.has(k)) return false; seen.add(k); return true; }).slice(0, 40);
  const advertisers = [...new Set(ads.map((a) => a.advertiser))];

  let report: AdsReport = { summary: "", ads, patterns: [], moves: [], advertisers, at: new Date().toISOString() };
  if (ads.length && isLlmConfigured()) {
    const list = ads.slice(0, 24).map((a, i) => `[${i}] ${a.advertiser}${a.cta ? ` (CTA: ${a.cta})` : ""}: ${a.text.slice(0, 200)}`).join("\n");
    try {
      const { data } = await getLlm().callStructured<{ summary: string; patterns: { pattern: string; example?: string }[]; moves: string[] }>({
        system: SYSTEM,
        text: `Business: "${ws.name}" (vertical: ${ws.vertical}).\n\nCOMPETITOR ADS (Meta Ad Library):\n${list}\n\nWhat are rivals promoting, and what should the owner do?`,
        schema: SCHEMA, tier: "extract", maxTokens: 1200,
      });
      report = {
        ...report,
        summary: strip(data.summary),
        patterns: (data.patterns ?? []).map((p) => ({ pattern: strip(p.pattern), example: strip(p.example) || undefined })).filter((p) => p.pattern).slice(0, 6),
        moves: (data.moves ?? []).map(strip).filter(Boolean).slice(0, 4),
      };
    } catch { /* keep the raw ads even if synthesis fails */ }
  }
  if (!ads.length) report.empty = true;

  const { data: cur } = await svc.from("workspace").select("goals").eq("id", ws.id).maybeSingle();
  await svc.from("workspace").update({ goals: { ...((cur?.goals as object) ?? {}), ads: report } }).eq("id", ws.id);
  return { activated: true, scraped: ads.length, advertisers: advertisers.length, costUsd: Number(costUsd.toFixed(4)) };
}

/** Read the cached ads report (populated by the gated refresh; never generates). */
export async function getAdsReport(ws: WorkspaceRow): Promise<AdsReport> {
  const supabase = await createClient();
  const { data } = await supabase.from("workspace").select("goals").eq("id", ws.id).maybeSingle();
  return ((data?.goals as { ads?: AdsReport } | null)?.ads) ?? empty(new Date().toISOString());
}
