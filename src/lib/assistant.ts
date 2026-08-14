import type { SupabaseClient } from "@supabase/supabase-js";
import { getLlm, isLlmConfigured } from "@/lib/extraction/llm";
import { retrieveLiveContext, type RetrievedSource } from "@/lib/retrieval";
import { upcomingOccasions } from "@/lib/occasions";
import { fetchRaniOps } from "@/lib/raniSlice";

/**
 * The grounded Q&A brain behind the WhatsApp assistant (and reusable for an in-app
 * chat). It answers an owner's question STRICTLY from the market data we've already
 * collected for their workspace — the cached pillars on goals — so it stays
 * personalized and, crucially, hallucination-resistant: it may only use facts that
 * are actually in the knowledge pack, and must say "I don't have that yet" when
 * they're absent. No new scrape or cost beyond one small LLM call.
 */

export interface ChatSource { label: string; business?: string; platform?: string; url?: string }
export interface AssistantAnswer { answer: string; grounded: boolean; sources?: ChatSource[] }
export interface WaTurn { role: "user" | "assistant"; text: string }
export interface BusinessCandidate { id: string; name: string; vertical?: string }

const clean = (v: unknown) => String(v ?? "").replace(/<\/?[a-z][^>]*>/gi, "").replace(/\s+/g, " ").trim();
const arr = (v: unknown): any[] => (Array.isArray(v) ? v : []);
const KNOWLEDGE_CAP = 7000;

/** Assemble a compact, structured "what we actually know" pack from the cached
 *  pillars. Only real, collected facts go in — this is the entire grounding. */
export function buildKnowledge(ws: { name: string; vertical?: string }, goals: Record<string, any>): string {
  const S: string[] = [];
  const push = (title: string, lines: string[]) => { if (lines.length) S.push(`## ${title}\n${lines.join("\n")}`); };

  // your reputation / position
  const rep = goals.you?.reputation;
  if (rep && (rep.rating != null || rep.marketAvg != null)) {
    const bits = [];
    if (rep.rating != null) bits.push(`your rating ${rep.rating}★`);
    if (rep.marketAvg != null) bits.push(`market average ${rep.marketAvg}★`);
    if (rep.rank && rep.total) bits.push(`rank #${rep.rank} of ${rep.total}`);
    const vel = rep.velocity;
    if (vel && typeof vel.ratingDelta === "number") bits.push(`rating ${vel.ratingDelta < 0 ? "down" : "up"} ${Math.abs(vel.ratingDelta).toFixed(1)}★ over ${vel.windowDays || "recent"} days`);
    push("Your reputation", [bits.join(", ")]);
  }

  // your current offers
  push("Your current offers", arr(goals.myDeals?.deals).slice(0, 8).map((d) => `- ${clean(d.deal)}${d.when ? ` (${clean(d.when)})` : ""}`).filter((x) => x.length > 2));

  // competitor priced items + promos
  const priced = arr(goals.flyerDeals?.deals).map((d) => `- ${clean(d.rival)}: ${clean(d.item)}${d.price ? ` — ${clean(d.price)}` : ""}`).filter((x) => x.length > 4).slice(0, 24);
  const promos = arr(goals.deals?.deals).map((d) => `- ${clean(d.rival)}: ${clean(d.deal)}`).filter((x) => x.length > 4).slice(0, 12);
  push("Competitor prices & deals (from their flyers/posts)", [...priced, ...promos]);

  // you vs rivals on price
  push("You vs rivals on price", arr(goals.priceGaps?.gaps).slice(0, 10).map((g) => {
    const you = g.yourPrice ? `you ${clean(g.yourPrice)}` : "you have no listed price";
    return `- ${clean(g.item)}: ${you} vs ${clean(g.rival)} ${clean(g.rivalPrice)} — ${clean(g.verdict)}${g.action ? `; suggested: ${clean(g.action)}` : ""}`;
  }).filter((x) => x.length > 6));

  // menu / service comparison
  const mc = goals.menuCompare;
  if (mc && !mc.empty) {
    const lines: string[] = [];
    if (mc.summary) lines.push(clean(mc.summary));
    for (const o of arr(mc.overview).slice(0, 8)) lines.push(`- ${clean(o.name)}: ${clean(o.positioning)} — ${clean(o.note)}`);
    for (const m of arr(mc.matches).slice(0, 8)) lines.push(`- ${clean(m.item)}: ${arr(m.entries).map((e) => `${e.isYou ? "you" : clean(e.business)} $${e.price}`).join(", ")}`);
    push("Menu / service price comparison", lines);
  }

  // what's popular / winning + unmet demand
  const pop = [
    ...arr(goals.winning?.winning).slice(0, 6).map((w) => `- ${clean(w.name)}${w.onYourMenu === false ? " (winning nearby, NOT on your menu)" : ""}${w.signal ? ` — ${clean(w.signal)}` : ""}`),
    ...arr(goals.demand?.demands).filter((d) => d.heat === "high").slice(0, 4).map((d) => `- Unmet demand: ${clean(d.need)}${d.signal ? ` — ${clean(d.signal)}` : ""}`),
  ].filter((x) => x.length > 4);
  push("What's popular / winning nearby", pop);

  // rival marketing
  const mkt: string[] = [];
  const sp = goals.socialPulse;
  if (sp && !sp.failed) {
    for (const b of arr(sp.breakouts).slice(0, 3)) if (b.rival) mkt.push(`- ${clean(b.rival)}'s post is breaking out (${b.multiple ? `${b.multiple}× usual` : "high engagement"}): "${clean(b.caption).slice(0, 100)}"`);
    for (const rf of arr(sp.risingFormats).slice(0, 2)) mkt.push(`- Rising content format: ${clean(rf)}`);
  }
  const ads = goals.ads;
  if (ads && !ads.empty && arr(ads.advertisers).length) mkt.push(`- Rivals running ads: ${arr(ads.advertisers).map(clean).filter(Boolean).slice(0, 4).join(", ")}${ads.moves?.[0] ? ` — ${clean(ads.moves[0])}` : ""}`);
  push("Rival marketing moves", mkt);

  // this week's highlights
  const dg = goals.digest;
  if (dg?.items?.length) {
    const lines = [clean(dg.headline), ...arr(dg.items).slice(0, 6).map((i) => `- ${clean(i.title)}: ${clean(i.detail)}`)].filter(Boolean);
    push("This period's highlights", lines);
  }

  let out = S.join("\n\n");
  if (out.length > KNOWLEDGE_CAP) out = out.slice(0, KNOWLEDGE_CAP) + "\n…(truncated)";
  return out;
}

const SCHEMA = {
  type: "object", additionalProperties: false,
  properties: {
    answer: { type: "string", description: "Concise answer, grounded strictly in DATA. Real names/numbers. No markdown headers." },
    grounded: { type: "boolean", description: "true only if DATA actually contained what was needed to answer; false if you had to say you don't have it." },
    sourceIds: { type: "array", items: { type: "string" }, description: "The [Ln] labels of the LIVE RECORDS you used for SPECIFIC facts. Empty for general advice, moves, or summary-only answers." },
  },
  required: ["answer", "grounded"],
};

const SYSTEM = (ws: { name: string; vertical?: string }) =>
  `You are Rani, the market-intelligence assistant AND local-marketing advisor for "${ws.name}"${ws.vertical ? ` (a ${ws.vertical})` : ""}. You help the OWNER using ONLY the DATA provided — real competitor/market info recently collected for them, plus a calendar of upcoming occasions.\n` +
  `The DATA has up to four parts:\n` +
  `• SUMMARIES — our analysis of their market (the OUTSIDE view).\n` +
  `• LIVE RECORDS — raw collected market rows (exact prices, specific posts, recent changes). MOST precise; prefer it for specifics.\n` +
  `• YOUR OPERATIONS — the business's OWN store data from Rani (real best-sellers, promos they're running, reachable loyalty customers, and their promote-and-earn advocates). These are first-party facts about THEIR business — the INSIDE view.\n` +
  `• UPCOMING OCCASIONS — calendar dates, for TIMING ideas ONLY. Never treat them as facts about competitors.\n` +
  `RULES:\n` +
  `1. Facts come ONLY from SUMMARIES/LIVE RECORDS (market) and YOUR OPERATIONS (their own store). NEVER invent or guess prices, names, ratings, dates, or sales numbers. If they aren't there, set grounded=false, say plainly you don't have that yet, and point to what you CAN answer or suggest a fresh scan.\n` +
  `2. COMBINE INSIDE + OUTSIDE. When the owner asks what to do / for a move, promo, campaign, or idea: give ONE or TWO concrete moves. Ground the rationale in real data — cross-reference YOUR OPERATIONS with the market: e.g., don't cut price on a best-seller even if a rival is cheaper; if a rival is winning something your OWN customers keep asking for, that's a strong signal; and if they have promote-and-earn advocates or a loyalty list, prefer ACTIVATING those (a zero-cost channel their own customers power) over matching rivals' paid ads. Time it to a relevant UPCOMING OCCASION when one fits. The creative idea is yours, but every fact must trace to DATA. Set grounded=true when built on real data.\n` +
  `3. Be concise and specific: short sentences or a tight list, real names and exact numbers, no markdown headers, no fluff. Talk like a sharp local advisor who knows their block — not like a report.\n` +
  `4. CITATIONS: LIVE RECORDS are labelled [L1], [L2], … When you state a SPECIFIC fact from one (an exact price, a specific post, a specific change), cite it inline with its label, e.g. [L2], and list every label you cited in sourceIds. Do NOT cite for general advice, move/promo ideas, occasion timing, or anything from SUMMARIES — leave sourceIds empty then. Never cite more than 3.\n` +
  `5. RECENT CONVERSATION (if given) is only for follow-up context, not facts.`;

interface AnswerOpts { id?: string; target_business_id?: string | null }

/** Answer an owner's question grounded strictly in their data. Fuses three layers:
 *  cached SUMMARIES + live retrieved RECORDS (when a db client + ws.id are given) +
 *  upcoming OCCASIONS for timely, advisor-style moves. `history` keeps follow-ups in
 *  context. Nothing outside this data may be asserted as fact. */
export async function answerFromData(
  ws: { name: string; vertical?: string } & AnswerOpts,
  goals: Record<string, any>,
  question: string,
  history: WaTurn[] = [],
  svc?: SupabaseClient,
): Promise<AssistantAnswer> {
  const q = clean(question);
  if (!q) return { answer: "Ask me anything about your market — competitor deals, prices, your rating vs rivals, what's trending nearby, or 'what should I run this month?'.", grounded: false };
  if (!isLlmConfigured()) return { answer: "The assistant isn't fully set up yet — please try again later.", grounded: false };

  const summaries = buildKnowledge(ws, goals);
  let liveText = "";
  let liveSources: RetrievedSource[] = [];
  if (svc && ws.id) {
    try { const lc = await retrieveLiveContext(svc, { id: ws.id, target_business_id: ws.target_business_id ?? null }, q); liveText = lc.text; liveSources = lc.sources; }
    catch { /* pillars still cover it */ }
  }

  // INSIDE view — the business's own Rani operations (best-sellers, promos, loyalty, promote-and-earn)
  let opsText = "";
  try { opsText = (await fetchRaniOps(ws, goals)).text; } catch { /* umbrella not wired — market-only */ }

  if (!summaries.trim() && !liveText.trim() && !opsText.trim()) {
    return { answer: `I don't have any market data collected for ${ws.name} yet. Once a scan runs, ask me about competitor deals, prices, your rating, or what to run next.`, grounded: false };
  }

  let occasions = "";
  try { const occ = upcomingOccasions(ws.vertical); if (occ.length) occasions = occ.map((o) => `- ${o.name} (in ${o.inDays} day${o.inDays === 1 ? "" : "s"}, ${o.whenISO}): ${o.note}`).join("\n"); } catch { /* timing is optional */ }

  const convo = history.slice(-6).filter((t) => clean(t.text));
  const historyText = convo.length
    ? `\nRECENT CONVERSATION (context only, NOT data):\n${convo.map((t) => `${t.role === "user" ? "Owner" : "You"}: ${clean(t.text).slice(0, 300)}`).join("\n")}\n`
    : "";

  const dataText =
    (summaries.trim() ? `# SUMMARIES (our analysis — the OUTSIDE/market view)\n${summaries}\n\n` : "") +
    (liveText.trim() ? `# LIVE RECORDS (raw market rows — most precise; prefer for exact prices/posts/changes; each labelled [Ln])\n${liveText}\n\n` : "") +
    (opsText.trim() ? `# YOUR OPERATIONS (from Rani — the business's OWN store: real best-sellers, promos, loyalty reach & promote-and-earn advocates)\n${opsText}\n\n` : "") +
    (occasions ? `# UPCOMING OCCASIONS (timing ideas only — NOT facts about competitors)\n${occasions}\n\n` : "");

  try {
    const { data } = await getLlm().callStructured<{ answer: string; grounded: boolean; sourceIds?: string[] }>({
      system: SYSTEM(ws),
      text: `DATA (real, recently collected for ${ws.name}):\n${dataText}${historyText}\nOWNER'S QUESTION: ${q}`,
      schema: SCHEMA, tier: "extract", maxTokens: 550,
    });
    const raw = clean(data.answer);
    if (!raw) return { answer: "I couldn't put that together — try rephrasing?", grounded: false };

    // cited ids = from the structured field ∪ any [Ln] markers left in the text
    const cited = new Set<string>((Array.isArray(data.sourceIds) ? data.sourceIds : []).map((s) => String(s).trim()));
    for (const m of raw.matchAll(/\[[^\]]*?(L\d+)[^\]]*?\]/g)) cited.add(m[1]);
    // strip citation brackets from the shown text so it reads clean
    const answer = raw.replace(/\s*\[[^\]]*?L\d+[^\]]*?\]/g, "").replace(/\s{2,}/g, " ").replace(/\s+([.,!?])/g, "$1").trim();

    const byId = new Map(liveSources.map((s) => [s.id, s]));
    const sources: ChatSource[] = [...cited].map((id) => byId.get(id)).filter((s): s is RetrievedSource => !!s)
      .slice(0, 3).map((s) => ({ label: s.label, business: s.business, platform: s.platform, url: s.url }));

    return { answer: answer || raw, grounded: !!data.grounded, ...(sources.length ? { sources } : {}) };
  } catch {
    return { answer: "Something went wrong answering that — please try again in a moment.", grounded: false };
  }
}

const ROUTE_SCHEMA = {
  type: "object", additionalProperties: false,
  properties: { index: { type: ["integer", "null"], description: "0-based index of the business the message is about, or null if it doesn't clearly indicate one." } },
  required: ["index"],
};

const tokenize = (s: string) => s.toLowerCase().replace(/[^a-z0-9 ]/g, " ").split(/\s+/).filter((t) => t.length >= 3);

/** Which of the owner's businesses is this message about? Heuristics first (a bare
 *  "1"/"2", or a distinctive name word), then a cheap LLM router. Returns null when
 *  unclear — e.g. a generic follow-up — so the caller keeps the active business. */
export async function routeToBusiness(candidates: BusinessCandidate[], message: string): Promise<number | null> {
  const msg = clean(message);
  if (candidates.length <= 1) return candidates.length ? 0 : null;

  // bare numeric selection ("2", "#2")
  const num = msg.match(/^\s*#?\s*(\d{1,2})\s*$/);
  if (num) { const i = Number(num[1]) - 1; if (i >= 0 && i < candidates.length) return i; }

  // distinctive-name-word match (a word owned by exactly one candidate)
  const owners = new Map<string, Set<number>>();
  candidates.forEach((c, i) => new Set(tokenize(c.name)).forEach((t) => (owners.get(t) ?? owners.set(t, new Set()).get(t)!).add(i)));
  const low = ` ${msg.toLowerCase()} `;
  const hits = candidates.map((c, i) => (tokenize(c.name).some((t) => owners.get(t)?.size === 1 && low.includes(` ${t} `)) ? i : -1)).filter((i) => i >= 0);
  if (hits.length === 1) return hits[0];

  if (!isLlmConfigured()) return null;
  try {
    const list = candidates.map((c, i) => `${i}) ${c.name}${c.vertical ? ` (${c.vertical})` : ""}`).join("\n");
    const { data } = await getLlm().callStructured<{ index: number | null }>({
      system: "You route an owner's WhatsApp message to which of their businesses it's about. Return the 0-based index, or null if the message doesn't clearly indicate one (a greeting, or a general follow-up that could apply to any). Prefer null over guessing.",
      text: `BUSINESSES:\n${list}\n\nMESSAGE: ${msg}\n\nWhich business is this message about?`,
      schema: ROUTE_SCHEMA, tier: "classify", maxTokens: 40,
    });
    const idx = data.index;
    return typeof idx === "number" && idx >= 0 && idx < candidates.length ? idx : null;
  } catch {
    return null;
  }
}
