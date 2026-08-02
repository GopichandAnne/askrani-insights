import { createClient, createServiceClient } from "@/lib/supabase/server";
import { workspaceBusinessIds, type WorkspaceRow } from "@/lib/workspace";
import { buildWorkspaceReport } from "@/lib/report";
import { getLlm, isLlmConfigured } from "@/lib/extraction/llm";

/**
 * "Your Edge" — the value layer. Instead of scattering raw signals across pages,
 * this synthesizes everything we collect (competitor social + offers + prices,
 * customer reviews, market events, local trends/news/openings) into a decision-
 * grade brief for a busy owner:
 *   • what competitors are doing DIFFERENTLY (and how to answer it)
 *   • what people REALLY think (themes from reviews/social, not just star ratings)
 *   • what's TRENDING in their field (and how to ride it)
 *   • which OFFERINGS are winning in the market
 *   • upcoming EVENTS worth preparing for
 * Every item carries a concrete "leverage" action. Grounded strictly in the data;
 * empty sections when the signal isn't there yet (never invented). Cached on the
 * workspace so the page is instant and cheap.
 */

export interface EdgeMove { competitor: string; move: string; category: string; differsFromYou: string; leverage: string; }
export interface EdgeTrend { trend: string; why: string; leverage: string; }
export interface EdgeOffering { offering: string; evidence: string; leverage: string; }
export interface EdgeEvent { title: string; when: string; why: string; action: string; }
export interface Edge {
  headline: string;
  theEdge: string;
  competitorMoves: EdgeMove[];
  sentiment: { loves: string[]; gripes: string[]; aboutYou: string; marketSummary: string };
  trends: EdgeTrend[];
  winningOfferings: EdgeOffering[];
  events: EdgeEvent[];
  dataThin: boolean; // true when we had little to work with (tell the user to collect more)
  at: string;
}

const SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    headline: { type: "string", description: "≤12 words: the single biggest opportunity or threat right now." },
    theEdge: { type: "string", description: "2–3 sentences: where you stand vs the market and the one lever with the most upside. Plain, specific, names/numbers." },
    competitorMoves: {
      type: "array", description: "Up to 6. What specific competitors are doing DIFFERENTLY (social campaigns, promo cadence, pricing, new products, activity level) that you are not.",
      items: {
        type: "object", additionalProperties: false,
        properties: {
          competitor: { type: "string" },
          move: { type: "string", description: "What they're doing, concretely (e.g. 'posting weekend produce sales 3× a week on Instagram')." },
          category: { type: "string", enum: ["social", "promo", "pricing", "product", "activity", "reputation"] },
          differsFromYou: { type: "string", description: "How this differs from what you do." },
          leverage: { type: "string", description: "One concrete move you can make in response." },
        },
        required: ["competitor", "move", "category", "differsFromYou", "leverage"],
      },
    },
    sentiment: {
      type: "object", additionalProperties: false, description: "What people really think — themes mined from review & social text, not just ratings.",
      properties: {
        loves: { type: "array", items: { type: "string" }, description: "Up to 5 things customers praise (about you if we have your reviews, else the market)." },
        gripes: { type: "array", items: { type: "string" }, description: "Up to 5 recurring complaints/gaps to fix or exploit." },
        aboutYou: { type: "string", description: "1–2 sentences on how you're perceived; say if we don't have enough of YOUR reviews yet." },
        marketSummary: { type: "string", description: "1–2 sentences on what customers in this category care about most." },
      },
      required: ["loves", "gripes", "aboutYou", "marketSummary"],
    },
    trends: {
      type: "array", description: "Up to 5 relevant industry/local trends worth acting on.",
      items: { type: "object", additionalProperties: false, properties: { trend: { type: "string" }, why: { type: "string", description: "Why it matters to you specifically." }, leverage: { type: "string" } }, required: ["trend", "why", "leverage"] },
    },
    winningOfferings: {
      type: "array", description: "Up to 5 products/offerings/formats that are clearly working in this market (from competitor menus/offers/social).",
      items: { type: "object", additionalProperties: false, properties: { offering: { type: "string" }, evidence: { type: "string", description: "What in the data shows it's working." }, leverage: { type: "string" } }, required: ["offering", "evidence", "leverage"] },
    },
    events: {
      type: "array", description: "Up to 5 upcoming events/moments to prepare for (local happenings, openings nearby, seasonal peaks relevant to this business).",
      items: { type: "object", additionalProperties: false, properties: { title: { type: "string" }, when: { type: "string", description: "Approx timing if known, else ''." }, why: { type: "string" }, action: { type: "string" } }, required: ["title", "when", "why", "action"] },
    },
    dataThin: { type: "boolean", description: "true if there was little collected data to analyze, so recommendations are thin." },
  },
  required: ["headline", "theEdge", "competitorMoves", "sentiment", "trends", "winningOfferings", "events", "dataThin"],
};

const SYSTEM = [
  "You are Ask Rani, a sharp local-market strategist advising a busy, non-technical small-business owner (the owner is \"you\").",
  "Write ONLY from the DATA provided. Be concrete: use real competitor names, product names, and numbers from the data. Never invent figures, reviews, events, or trends that aren't supported.",
  "Every insight must be genuinely useful and specific to THIS business and market — no generic filler. Each item needs a concrete, doable 'leverage' action.",
  "Focus on what's DIFFERENT and ACTIONABLE: what rivals do that you don't, what customers actually say, what's demonstrably working, what's coming up.",
  "If a section has little support in the data, return fewer (or zero) items and set dataThin=true rather than padding. Plain English, no jargon.",
].join(" ");

/** Assemble the grounded signal context the strategist reasons over. */
async function buildEdgeContext(ws: WorkspaceRow) {
  const report = await buildWorkspaceReport(ws);
  const supabase = await createClient();
  const ids = await workspaceBusinessIds(ws);
  const scope = ids.all.length ? ids.all : ["00000000-0000-0000-0000-000000000000"];
  const youName = report.pricing.find((p) => p.isTarget)?.name ?? ws.name;

  const { data: content } = await supabase
    .from("content_item")
    .select("platform,text,media,observed_at,business:business_id,business_id")
    .in("business_id", scope)
    .order("observed_at", { ascending: false })
    .limit(600);

  // name lookup
  const { data: biz } = await supabase.from("business").select("id,canonical_name").in("id", scope);
  const nameOf = new Map((biz ?? []).map((b: any) => [b.id, b.canonical_name]));
  const isYou = (bid: string) => bid === ids.targetId;

  const SOCIAL = new Set(["instagram", "facebook", "tiktok", "youtube"]);
  const clean = (s: string) => String(s ?? "").replace(/\s+/g, " ").trim();

  // competitor social posts (their captions = what they're doing) grouped, cap each
  const socialByBiz: Record<string, string[]> = {};
  const yourSocial: string[] = [];
  const reviewsByBiz: Record<string, string[]> = {};
  const yourReviews: string[] = [];
  for (const c of content ?? []) {
    const bid = (c as any).business_id as string;
    const name = (nameOf.get(bid) as string) ?? "A business";
    const plat = (c as any).platform as string;
    const txt = clean((c as any).text).slice(0, 220);
    if (!txt) continue;
    if (SOCIAL.has(plat)) {
      if (isYou(bid)) { if (yourSocial.length < 12) yourSocial.push(txt); }
      else { (socialByBiz[name] ??= []).length < 8 && socialByBiz[name].push(`[${plat}] ${txt}`); }
    } else if (plat === "yelp" || plat === "google") {
      if (isYou(bid)) { if (yourReviews.length < 16) yourReviews.push(txt); }
      else { (reviewsByBiz[name] ??= []).length < 6 && reviewsByBiz[name].push(txt); }
    }
  }

  // offers sample by business (what they sell + prices)
  const { data: offers } = await supabase
    .from("offer").select("entity_text,pricing,business_id").in("business_id", scope).order("observed_at", { ascending: false }).limit(600);
  const offersByBiz: Record<string, { item: string; price?: number }[]> = {};
  const seen: Record<string, Set<string>> = {};
  for (const o of offers ?? []) {
    const name = (nameOf.get((o as any).business_id) as string) ?? "A business";
    const item = clean((o as any).entity_text);
    if (!item) continue;
    seen[name] ??= new Set();
    if (seen[name].has(item.toLowerCase())) continue;
    seen[name].add(item.toLowerCase());
    const amt = Number((o as any).pricing?.amount);
    ((offersByBiz[name] ??= []).length < 16) && offersByBiz[name].push({ item, price: Number.isFinite(amt) && amt > 0 ? amt : undefined });
  }

  // local market radar: trends / news / openings with article text
  const localNews = (content ?? [])
    .filter((c: any) => c.platform === "news")
    .slice(0, 14)
    .map((c: any) => ({ headline: clean(c.text), kind: c.media?.[0]?.kind ?? "news", source: c.media?.[0]?.source ?? "", article: clean(c.media?.[0]?.excerpt ?? "").slice(0, 600) || undefined }));

  return {
    you: youName,
    vertical: ws.vertical,
    positioning: {
      pricing: report.pricing.map((p) => ({ name: p.name, you: p.isTarget, avgPrice: p.avgPrice, pricedItems: p.offers })),
      reputation: report.reputation.map((r) => ({ name: r.name, you: r.isTarget, rating: r.rating, reviews: r.reviewCount, bySource: r.sources.map((s) => ({ source: s.source, rating: s.rating, reviews: s.reviewCount })) })),
    },
    competitorActivity: report.events.slice(0, 20).map((e) => ({ business: e.business, type: e.type, summary: e.summary })),
    competitorSocial: socialByBiz,
    yourSocial,
    reviewsAboutYou: yourReviews,
    competitorReviews: reviewsByBiz,
    offeringsByBusiness: offersByBiz,
    localTrendsNewsOpenings: localNews,
  };
}

// Guard against models that occasionally bleed tool-call / XML syntax into a
// string field (e.g. "...act on.</theEdge> <parameter name=…>"). Cut any string
// at the first tag-like artifact and collapse whitespace.
function stripTags(s: string): string {
  const i = s.search(/<\/|<(parameter|function|antml|invoke)\b/i);
  return (i >= 0 ? s.slice(0, i) : s).replace(/\s+/g, " ").trim();
}
function deepStrip<T>(v: T): T {
  if (typeof v === "string") return stripTags(v) as unknown as T;
  if (Array.isArray(v)) return v.map(deepStrip) as unknown as T;
  if (v && typeof v === "object") {
    const o: Record<string, unknown> = {};
    for (const k of Object.keys(v as object)) o[k] = deepStrip((v as Record<string, unknown>)[k]);
    return o as T;
  }
  return v;
}

export async function generateEdge(ws: WorkspaceRow): Promise<Edge> {
  const at = new Date().toISOString();
  const empty: Edge = {
    headline: "Collect your market to unlock your edge",
    theEdge: "Once we've gathered your competitors' offers, reviews, and social, this becomes a live playbook of what they're doing differently and how to win.",
    competitorMoves: [], sentiment: { loves: [], gripes: [], aboutYou: "", marketSummary: "" }, trends: [], winningOfferings: [], events: [], dataThin: true, at,
  };
  if (!isLlmConfigured()) return { ...empty, headline: "Connect an AI key to unlock your edge", theEdge: "Add an AI key and Ask Rani will synthesize your market signals into an action plan." };

  const context = await buildEdgeContext(ws);
  try {
    const { data } = await getLlm().callStructured<Omit<Edge, "at">>({
      system: SYSTEM,
      text: `Analyze this local business and its market, then produce the edge brief.\n\nDATA (JSON):\n${JSON.stringify(context)}`,
      schema: SCHEMA,
      tier: "extract",
      maxTokens: 4000,
    });
    // Normalize so a truncated/partial tool output can never yield undefined
    // arrays (which would blank the page) — every field gets a safe default.
    const d = (data ?? {}) as Partial<Edge>;
    const s = (d.sentiment ?? {}) as Partial<Edge["sentiment"]>;
    const norm: Edge = {
      headline: d.headline || empty.headline,
      theEdge: d.theEdge || empty.theEdge,
      competitorMoves: Array.isArray(d.competitorMoves) ? d.competitorMoves : [],
      sentiment: {
        loves: Array.isArray(s.loves) ? s.loves : [],
        gripes: Array.isArray(s.gripes) ? s.gripes : [],
        aboutYou: s.aboutYou || "",
        marketSummary: s.marketSummary || "",
      },
      trends: Array.isArray(d.trends) ? d.trends : [],
      winningOfferings: Array.isArray(d.winningOfferings) ? d.winningOfferings : [],
      events: Array.isArray(d.events) ? d.events : [],
      dataThin: !!d.dataThin,
      at,
    };
    return deepStrip(norm);
  } catch {
    return empty;
  }
}

/** Cached edge, regenerated when older than maxAgeHours or when forced. */
export async function getOrMakeEdge(ws: WorkspaceRow, opts: { maxAgeHours?: number; force?: boolean } = {}): Promise<Edge> {
  const { maxAgeHours = 24, force = false } = opts;
  const supabase = await createClient();
  const { data } = await supabase.from("workspace").select("goals").eq("id", ws.id).maybeSingle();
  const cached = (data?.goals as any)?.edge as Edge | undefined;
  if (!force && cached?.at && Date.now() - new Date(cached.at).getTime() < maxAgeHours * 3600_000) return deepStrip(cached);

  const fresh = await generateEdge(ws);
  // Cache under goals.edge (workspace has no dedicated settings column).
  const svc = createServiceClient();
  const { data: cur } = await svc.from("workspace").select("goals").eq("id", ws.id).maybeSingle();
  await svc.from("workspace").update({ goals: { ...((cur?.goals as any) ?? {}), edge: fresh } }).eq("id", ws.id);
  return fresh;
}
