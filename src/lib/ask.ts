import { activeWorkspace, workspaceBusinessIds } from "@/lib/workspace";
import { createClient } from "@/lib/supabase/server";
import { buildWorkspaceReport } from "@/lib/report";
import { buildScorecard } from "@/lib/scorecard";
import { getLlm, isLlmConfigured } from "@/lib/extraction/llm";
import { type Source, SOURCES_SENTINEL } from "@/lib/ask-shared";

/**
 * "Ask Rani" inline answers — natural-language questions answered over the
 * workspace's own collected data (pricing, reputation, events, recommendations,
 * cost). Grounded: Claude may only use the supplied data and must say when it
 * can't answer, so the command bar never invents numbers.
 */

export interface AskResult {
  answerable: boolean;
  answer: string;
  workspace?: string;
}

const GROUNDING = [
  "You are Ask Rani, an expert local-market strategist advising a busy, non-technical small-business owner (the owner is \"you\").",
  "You have the FULL picture in DATA: a competitive SCORECARD (your position score + rank, and every metric — rating, price, social reach, AI search, Google findability — as YOUR score vs the market AVERAGE vs the category LEADER), plus findability detail (which searches you're losing), AI-search detail (who the AIs recommend), item prices, reviews, recent market events, open recommendations, and citable SOURCES (reviews, website, delivery apps, social, local news).",
  "For EVERY answer, be a strategist who drives action — not a data-reader. Structure: (1) answer directly with the specific numbers from DATA, (2) briefly say WHY when it helps, (3) give ONE concrete, doable next step to fix it or capitalize on it. Always end with that next step.",
  "Ground everything in DATA — real names and real numbers, never invent or estimate figures that aren't present. If a specific number is genuinely missing, say briefly how to get it, but STILL give your best strategic guidance from what IS there (especially the scorecard).",
  "Map the owner's wording to the DATA and never claim a metric 'isn't available' when the scorecard has it: 'social'/'social search'/'social score' → the Social reach metric; 'AI'/'ChatGPT'/'AI search' → AI search; 'ranking'/'show up on Google'/'found' → Findability; 'reputation'/'stars' → Rating.",
  "Prices are USD. 'offers' = whatever this business sells. When a claim rests on a SOURCE, cite it inline by number in square brackets, e.g. [2] — only numbers that appear in SOURCES.",
  "Tailor EVERY answer to DATA.businessType — reason and advise as an expert in THAT industry, and read the generic pillars through its lens: 'offers'/'winning items'/'menu' mean this business's actual thing (dishes for a restaurant, products for a grocery, treatments/services for a salon or clinic, listings for real estate, classes for fitness). Never give generic or off-industry advice, and never assume it's a restaurant unless businessType says so.",
  "Keep it tight: 2–5 sentences, plain English, no jargon, and make the next step specific enough to do today.",
].join(" ");

const SYSTEM_STRUCTURED = `${GROUNDING} If the data doesn't contain the answer, set answerable=false and briefly say what's missing or suggest collecting more.`;
const SYSTEM_STREAM = `${GROUNDING} If the data doesn't contain the answer, say so briefly and suggest what to collect — do not guess.`;

const SOURCE_LABEL: Record<string, string> = {
  website: "Website", pdf: "Menu (PDF)", google: "Google", yelp: "Yelp",
  instagram: "Instagram", facebook: "Facebook", tiktok: "TikTok", youtube: "YouTube",
  doordash: "DoorDash", ubereats: "UberEats", news: "News",
};
const SOCIAL_PLATFORMS = new Set(["instagram", "facebook", "tiktok", "youtube"]);


const SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    answerable: { type: "boolean", description: "true if the DATA supports a real answer" },
    answer: { type: "string", description: "Plain-English strategist answer (2–5 sentences): the read with real numbers, the why, and one concrete next step to act on." },
  },
  required: ["answerable", "answer"],
};

type Prompt = { text: string; workspace: string; sources: Source[] } | { guard: string };

/** Assemble the grounded context prompt for a question (shared by stream + non-stream). */
async function buildAskPrompt(question: string): Promise<Prompt> {
  const q = (question ?? "").trim();
  if (!q) return { guard: "Ask me anything about your market — prices, competitors, ratings, or what to do next." };
  if (!isLlmConfigured()) return { guard: "The assistant isn't configured yet (no AI key)." };

  const state = await activeWorkspace();
  if (state.status !== "ok") {
    return { guard: "Set up your business first, then I can answer questions about your local market." };
  }
  const ws = state.workspace;

  // Build the raw report AND the synthesized competitive scorecard in parallel —
  // the scorecard is what makes Rani an ADVISOR (it knows every metric vs the
  // market + leader), not just a reader of raw rows.
  const [report, scorecard] = await Promise.all([buildWorkspaceReport(ws), buildScorecard(ws)]);
  const supabase = await createClient();
  const ids = await workspaceBusinessIds(ws);
  const scope = ids.all.length ? ids.all : ["00000000-0000-0000-0000-000000000000"];

  // Item-level pricing sample so "who has the cheapest cheese pizza?" works.
  const { data: offers } = await supabase
    .from("offer")
    .select("entity_text,pricing,business:business_id(canonical_name)")
    .in("business_id", scope)
    .order("observed_at", { ascending: false })
    .limit(500);
  const sample: Record<string, { item: string; price: number }[]> = {};
  const seen: Record<string, Set<string>> = {};
  for (const o of offers ?? []) {
    const name = (o.business as any)?.canonical_name ?? "Unknown";
    const amount = Number((o.pricing as any)?.amount);
    if (!Number.isFinite(amount) || amount <= 0) continue;
    const key = String((o as any).entity_text ?? "").toLowerCase().trim();
    if (!key) continue;
    seen[name] ??= new Set();
    if (seen[name].has(key)) continue;
    seen[name].add(key);
    (sample[name] ??= []).push({ item: (o as any).entity_text, price: amount });
  }
  for (const k of Object.keys(sample)) sample[k] = sample[k].slice(0, 14);

  // Citable sources — the actual content items we collected across every channel
  // (reviews, website, delivery apps, social media, and local news). The SOURCES
  // sample is QUESTION-AWARE: it scores each item against the question and its
  // intent (social? news/openings?), so asking about social pulls in more social,
  // asking about openings pulls in news — nothing relevant gets capped out.
  const { data: content } = await supabase
    .from("content_item")
    .select("platform,url,text,media,observed_at,published_at,business:business_id(canonical_name)")
    .in("business_id", scope)
    .order("observed_at", { ascending: false })
    .limit(160);

  const ql = q.toLowerCase();
  const intentSocial = /social|instagram|insta|facebook|tiktok|youtube|post(ing|ed|s)?|reel|caption|feed/.test(ql);
  const intentNews = /news|trend|trending|open(ed|ing|s)?|launch|nearby|region|area|happening|industry|market|competitor.*(open|new)|new (place|spot|restaurant|store)/.test(ql);
  const qTokens = ql.split(/[^a-z0-9]+/).filter((t) => t.length > 3);

  const scoreItem = (platform: string, business: string, text: string): number => {
    let s = 0;
    const hay = `${SOURCE_LABEL[platform] ?? platform} ${business} ${text}`.toLowerCase();
    for (const t of qTokens) if (hay.includes(t)) s += 2;
    if (intentSocial && SOCIAL_PLATFORMS.has(platform)) s += 6;
    if (intentNews && platform === "news") s += 8;
    return s;
  };
  const capFor = (platform: string): number => {
    if (intentSocial && SOCIAL_PLATFORMS.has(platform)) return 5;
    if (intentNews && platform === "news") return 6;
    return 2;
  };

  const excerptOf = (c: any): string => String(c.media?.[0]?.excerpt ?? "");
  const scored = (content ?? [])
    .map((c: any) => ({
      c,
      platform: c.platform as string,
      business: (c.business as any)?.canonical_name ?? "Unknown",
      text: String(c.text ?? ""),
      excerpt: excerptOf(c),
    }))
    .map((x) => ({ ...x, rel: scoreItem(x.platform, x.business, `${x.text} ${x.excerpt}`) }))
    .sort((a, b) => b.rel - a.rel || String(b.c.observed_at).localeCompare(String(a.c.observed_at)));

  const sources: Source[] = [];
  const sourceNotes: { id: number; business: string; source: string; note: string }[] = [];
  const perKey = new Map<string, number>();
  for (const x of scored) {
    if (sources.length >= 32) break;
    const key = `${x.business}|${x.platform}`;
    if ((perKey.get(key) ?? 0) >= capFor(x.platform)) continue;
    perKey.set(key, (perKey.get(key) ?? 0) + 1);
    const id = sources.length + 1;
    const label = SOURCE_LABEL[x.platform] ?? x.platform;
    sources.push({ id, business: x.business, platform: x.platform, label, url: x.c.url ?? undefined });
    // for news, cite the article body (deeper trends) not just the headline
    const note = (x.platform === "news" && x.excerpt ? `${x.text}. ${x.excerpt}` : x.text).replace(/\s+/g, " ").trim().slice(0, 340);
    sourceNotes.push({ id, business: x.business, source: label, note });
  }

  // Local market radar (industry trends / local news / nearby openings) with the
  // extracted article text, so Rani can give specifics, not just headlines.
  const localNews = (content ?? [])
    .filter((c: any) => c.platform === "news")
    .slice(0, 12)
    .map((c: any) => ({
      headline: c.text,
      source: c.media?.[0]?.source ?? "",
      kind: c.media?.[0]?.kind ?? "news",
      when: c.published_at ?? undefined,
      article: String(c.media?.[0]?.excerpt ?? "").slice(0, 700) || undefined,
    }));

  // ── the synthesized intelligence: scorecard + pillar headlines ──────────────
  const { data: wRow } = await supabase.from("workspace").select("goals").eq("id", ws.id).maybeSingle();
  const goals = (wRow?.goals ?? {}) as Record<string, any>;
  const fnd = goals.findability && !goals.findability.empty ? goals.findability : null;
  const aif = goals.aiFindability && !goals.aiFindability.empty ? goals.aiFindability : null;
  const g = goals;
  const arr = (x: any): any[] => (Array.isArray(x) ? x : []);
  const clip = (s: any, n = 160): string | undefined => (s == null ? undefined : String(s).slice(0, n));
  const themeOf = (x: any) => (typeof x === "string" ? x : x?.theme ?? x?.name ?? x?.format ?? x?.topic);

  // The FULL synthesized picture — every pillar the app computes, compacted to
  // headline + a few key items so Rani reasons like the whole product, not one page.
  const intel = {
    // your position + every metric as you vs market-average vs the leader (with gaps)
    scorecard: scorecard.empty ? null : {
      positionScore: scorecard.composite.you, rank: scorecard.composite.rank, of: scorecard.composite.total,
      headline: scorecard.headline,
      metrics: scorecard.metrics.map((m) => ({ metric: m.label, you: m.you, marketAvg: m.avg, best: m.best, leader: m.bestName })),
    },
    // one-line exec briefing
    briefing: g.briefing ? { headline: clip(g.briefing.headline), summary: clip(g.briefing.summary, 240) } : null,
    // how YOU are doing: health, what customers love/gripe, price position
    you: g.you ? { health: g.you.synthesis?.health, summary: clip(g.you.synthesis?.summary, 240), customersLove: arr(g.you.synthesis?.loves).slice(0, 4).map(themeOf), gripes: arr(g.you.synthesis?.gripes).slice(0, 3).map((x: any) => x?.theme ?? x), price: g.you.price } : null,
    // Google findability: your score + the searches you're losing (fix targets)
    findability: fnd ? {
      score: fnd.score, inTop3: fnd.coverage?.inTop3, ofTerms: fnd.coverage?.total,
      losing: (fnd.keywords ?? []).filter((k: any) => k.yourRank == null || k.yourRank > 3).slice(0, 6).map((k: any) => ({ term: k.term, yourRank: k.yourRank, leader: k.topCompetitor })),
    } : null,
    // AI search: your score + who the AIs recommend instead
    aiSearch: aif ? { score: aif.score, engines: aif.engines, aiRecommends: (aif.competitorsRecommended ?? []).slice(0, 5).map((c: any) => c.name) } : null,
    // review pulse: rising/fading themes + rating movement
    reviewPulse: g.pulse ? { summary: clip(g.pulse.summary), rising: arr(g.pulse.rising).slice(0, 4).map(themeOf), fading: arr(g.pulse.fading).slice(0, 3).map(themeOf), ratingDelta: g.pulse.ratingDelta, newReviews: g.pulse.newReviews } : null,
    // social pulse: what formats are breaking out on rivals' feeds
    socialPulse: g.socialPulse ? { summary: clip(g.socialPulse.summary), risingFormats: arr(g.socialPulse.risingFormats).slice(0, 4).map(themeOf), breakouts: arr(g.socialPulse.breakouts).slice(0, 3).map((b: any) => ({ rival: b.rival, caption: clip(b.caption, 90) })) } : null,
    // what's winning in the market + whether it's already on your lineup
    whatsWinning: g.winning ? { summary: clip(g.winning.summary), items: arr(g.winning.winning).slice(0, 6).map((x: any) => ({ name: x.name, onYourLineup: x.onYourMenu, move: clip(x.move, 110), momentum: x.momentum })) } : null,
    // content ideas: swipe-worthy formats, hashtags, collab candidates
    contentIdeas: g.content && !g.content.empty ? { swipe: arr(g.content.swipe).slice(0, 4).map((s: any) => ({ format: s.format, from: s.business, yourVersion: clip(s.yourVersion, 120) })), hashtags: arr(g.content.hashtags).slice(0, 6).map((h: any) => h?.tag ?? h), collabs: arr(g.content.collabs).slice(0, 4).map((c: any) => c?.handle ?? c) } : null,
    // rivals' live deals/promotions + suggested counter-moves
    competitorDeals: g.deals ? { summary: clip(g.deals.summary), deals: arr(g.deals.deals).slice(0, 5).map((d: any) => ({ rival: d.rival, deal: clip(d.deal, 110), when: d.when })), suggestedMoves: arr(g.deals.moves).slice(0, 4).map((m: any) => clip(m, 120)) } : null,
    // unmet demand from reviews (what customers want that isn't served well)
    unmetDemand: g.demand ? { summary: clip(g.demand.summary), needs: arr(g.demand.demands).slice(0, 5).map((x: any) => ({ need: x.need, move: clip(x.move, 110), servedLocally: x.servedLocally })) } : null,
    // local trends + your recommended move for each
    localTrends: g.localTrends ? { summary: clip(g.localTrends.summary), trends: arr(g.localTrends.trends).slice(0, 5).map((t: any) => ({ topic: t.topic, momentum: t.momentum, yourMove: clip(t.yourMove, 110) })) } : null,
    // rivals' current flyer/sale prices (when present)
    flyerDeals: g.flyerDeals && !g.flyerDeals.empty ? arr(g.flyerDeals.deals).slice(0, 8) : null,
  };

  const context = {
    you: report.pricing.find((p) => p.isTarget)?.name ?? ws.name,
    businessType: ws.vertical,   // restaurant | grocery | salon | dental | fitness | real_estate | smoke_vape | other
    intel,
    businesses: report.pricing.map((p) => ({
      name: p.name, you: p.isTarget, pricedItems: p.offers, avgPrice: p.avgPrice, minPrice: p.minPrice, maxPrice: p.maxPrice,
    })),
    reputation: report.reputation.map((r) => ({ name: r.name, you: r.isTarget, rating: r.rating, reviews: r.reviewCount })),
    recentEvents: report.events.slice(0, 18).map((e) => ({ business: e.business, type: e.type, summary: e.summary })),
    recommendations: report.recommendations.slice(0, 8).map((r) => ({ title: r.title, action: r.action })),
    monitoringCost: { projectedPerMonthUsd: report.cost.projectedMonthlyUsd, perBusinessPerMonthUsd: report.cost.perBusinessMonthlyUsd, spentInWindowUsd: report.cost.totalUsd, days: report.cost.days },
    sampleOffersByBusiness: sample,
    localNews,
    sources: sourceNotes,
  };

  return { text: `Question: ${q}\n\nDATA (JSON):\n${JSON.stringify(context)}`, workspace: ws.name, sources };
}

/** One-shot grounded answer (structured). */
export async function answerQuestion(question: string): Promise<AskResult> {
  const p = await buildAskPrompt(question);
  if ("guard" in p) return { answerable: false, answer: p.guard };
  try {
    const { data } = await getLlm().callStructured<AskResult>({
      system: SYSTEM_STRUCTURED, text: p.text, schema: SCHEMA, tier: "extract", maxTokens: 700,
    });
    return { answerable: !!data.answerable, answer: String(data.answer ?? "").trim() || "I couldn't find that in your data yet.", workspace: p.workspace };
  } catch (e) {
    return { answerable: false, answer: `Sorry — I couldn't answer that just now (${(e as Error).message}).` };
  }
}

/** Streamed grounded answer — yields text deltas token-by-token, then a sources
 *  block (after SOURCES_SENTINEL) so the client can render clickable citations. */
export async function* streamAnswer(question: string): AsyncIterable<string> {
  const p = await buildAskPrompt(question);
  if ("guard" in p) { yield p.guard; return; }
  try {
    for await (const delta of getLlm().streamText({ system: SYSTEM_STREAM, text: p.text, tier: "extract", maxTokens: 700 })) {
      yield delta;
    }
  } catch (e) {
    yield `\n\n(Sorry — I hit a problem answering that: ${(e as Error).message})`;
  }
  if (p.sources.length) yield SOURCES_SENTINEL + JSON.stringify(p.sources);
}
