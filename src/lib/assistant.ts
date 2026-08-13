import { getLlm, isLlmConfigured } from "@/lib/extraction/llm";

/**
 * The grounded Q&A brain behind the WhatsApp assistant (and reusable for an in-app
 * chat). It answers an owner's question STRICTLY from the market data we've already
 * collected for their workspace — the cached pillars on goals — so it stays
 * personalized and, crucially, hallucination-resistant: it may only use facts that
 * are actually in the knowledge pack, and must say "I don't have that yet" when
 * they're absent. No new scrape or cost beyond one small LLM call.
 */

export interface AssistantAnswer { answer: string; grounded: boolean }

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
    answer: { type: "string", description: "Concise WhatsApp answer, grounded strictly in DATA. Real names/numbers. No markdown headers." },
    grounded: { type: "boolean", description: "true only if DATA actually contained what was needed to answer; false if you had to say you don't have it." },
  },
  required: ["answer", "grounded"],
};

const SYSTEM = (ws: { name: string; vertical?: string }) =>
  `You are Rani, the market-intelligence assistant for "${ws.name}"${ws.vertical ? ` (a ${ws.vertical})` : ""}. You answer the OWNER's questions about their local market using ONLY the DATA provided — real competitor and market information recently collected for them.\n` +
  `RULES:\n` +
  `1. Use ONLY facts present in DATA. NEVER invent or guess prices, competitor names, ratings, dates, or numbers. Do not use outside knowledge.\n` +
  `2. If DATA doesn't contain what's needed, set grounded=false and say plainly you don't have that yet — then point them to what you CAN answer (competitor deals & prices, you-vs-rivals on price, your rating vs the market, what's trending nearby) or suggest running a fresh scan.\n` +
  `3. Be concise and specific for WhatsApp: 1–5 short sentences or a tight bullet list. Use their real competitor names and exact numbers from DATA. No markdown headers, no preamble, no fluff.\n` +
  `4. Only report what DATA shows — never claim to perform actions.`;

/** Answer an owner's question grounded strictly in their collected data. */
export async function answerFromData(ws: { name: string; vertical?: string }, goals: Record<string, any>, question: string): Promise<AssistantAnswer> {
  const q = clean(question);
  if (!q) return { answer: "Ask me anything about your market — competitor deals, prices, your rating vs rivals, or what's trending nearby.", grounded: false };
  if (!isLlmConfigured()) return { answer: "The assistant isn't fully set up yet — please try again later.", grounded: false };

  const knowledge = buildKnowledge(ws, goals);
  if (!knowledge.trim()) {
    return { answer: `I don't have any market data collected for ${ws.name} yet. Once a scan runs, ask me about competitor deals, prices, your rating, or what's trending nearby.`, grounded: false };
  }

  try {
    const { data } = await getLlm().callStructured<{ answer: string; grounded: boolean }>({
      system: SYSTEM(ws),
      text: `DATA (real, recently collected for ${ws.name}):\n${knowledge}\n\nOWNER'S QUESTION: ${q}`,
      schema: SCHEMA, tier: "extract", maxTokens: 500,
    });
    const answer = clean(data.answer);
    return { answer: answer || "I couldn't put that together — try rephrasing?", grounded: !!data.grounded };
  } catch {
    return { answer: "Something went wrong answering that — please try again in a moment.", grounded: false };
  }
}
