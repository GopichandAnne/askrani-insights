import { activeWorkspace, workspaceBusinessIds } from "@/lib/workspace";
import { createClient } from "@/lib/supabase/server";
import { buildWorkspaceReport } from "@/lib/report";
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
  "You are Ask Rani, a friendly local-market analyst for a busy, non-technical small-business owner.",
  "Answer ONLY from the DATA provided (the owner is \"you\"). Be concise: 1–4 short sentences, plain English, no jargon.",
  "Use specific business names and real numbers from the data. Never invent or estimate figures that aren't present.",
  "Prices are in USD. 'offers' means menu items/products. 'events' are recent market changes.",
  "A numbered SOURCES list is provided — customer reviews (Yelp/Google), the business's own website & menus, delivery apps (DoorDash/UberEats), social media posts (Instagram/Facebook/TikTok/YouTube), and local market radar: industry trends, local news, and nearby openings (News).",
  "You may reference any source, including social posts and news. When a statement rests on a source, cite it inline with its number in square brackets, e.g. [2]. Only cite numbers that appear in SOURCES.",
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
    answer: { type: "string", description: "Concise plain-English answer (1–4 sentences)." },
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

  const report = await buildWorkspaceReport(ws);
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

  const context = {
    you: report.pricing.find((p) => p.isTarget)?.name ?? ws.name,
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
      system: SYSTEM_STRUCTURED, text: p.text, schema: SCHEMA, tier: "extract", maxTokens: 500,
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
    for await (const delta of getLlm().streamText({ system: SYSTEM_STREAM, text: p.text, tier: "extract", maxTokens: 500 })) {
      yield delta;
    }
  } catch (e) {
    yield `\n\n(Sorry — I hit a problem answering that: ${(e as Error).message})`;
  }
  if (p.sources.length) yield SOURCES_SENTINEL + JSON.stringify(p.sources);
}
