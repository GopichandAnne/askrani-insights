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
/** A change the copilot can perform when the owner asks (executed by the caller,
 *  not here — this brain only DECIDES). Same "Ask" feature, now able to act. */
export type AssistantAction =
  | { kind: "set_notify_email"; email: string }
  | { kind: "set_notify_whatsapp"; phone: string }
  | { kind: "link_rani_store"; slug: string }
  | { kind: "remove_competitor"; name: string };
export interface AssistantAnswer { answer: string; grounded: boolean; sources?: ChatSource[]; action?: AssistantAction }
export interface WaTurn { role: "user" | "assistant"; text: string }
export interface BusinessCandidate { id: string; name: string; vertical?: string }

const clean = (v: unknown) => String(v ?? "").replace(/<\/?[a-z][^>]*>/gi, "").replace(/\s+/g, " ").trim();
const arr = (v: unknown): any[] => (Array.isArray(v) ? v : []);
const KNOWLEDGE_CAP = 7000;

/** Assemble a compact, structured "what we actually know" pack from the cached
 *  pillars. Only real, collected facts go in — this is the entire grounding. */
export function buildKnowledge(ws: { name: string; vertical?: string }, goals: Record<string, any>, query = ""): string {
  const S: string[] = [];
  const push = (title: string, lines: string[]) => { if (lines.length) S.push(`## ${title}\n${lines.join("\n")}`); };
  // Content terms from the question (≥4 letters, minus common words, plural-loose)
  // so an item question like "who's cheapest on tomatoes?" surfaces EVERY rival's
  // tomato line — without junk stems like "ha" (from "has") matching everything.
  const STOP = new Set(["best", "price", "prices", "cheap", "cheaper", "cheapest", "what", "which", "does", "near", "this", "that", "week", "weekly", "today", "have", "with", "your", "their", "them", "they", "there", "here", "list", "give", "show", "tell", "much", "many", "most", "some", "compare", "vs", "than", "more", "less", "lowest", "highest", "deal", "deals", "sale", "sales", "offer", "offers", "right", "know", "want", "need", "good", "better"]);
  const qStem = (s: string) => s.replace(/(?:es|s)$/, "");
  const qWords = [...new Set((query.toLowerCase().match(/[a-z]{4,}/g) ?? []).filter((w) => !STOP.has(w)).map(qStem))];
  const qHit = (text: string) => { const t = text.toLowerCase(); return qWords.some((w) => w.length >= 4 && t.includes(w)); };

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

  // competitor priced items + promos — items matching the question come FIRST so a
  // specific "price on X?" question sees every rival that lists X (cap lifted when
  // the question is item-specific).
  const flyer = arr(goals.flyerDeals?.deals);
  const rank = (d: any) => (qWords.length && qHit(`${d.item ?? ""} ${d.rival ?? ""}`) ? 0 : 1);
  // YOUR OWN advertised prices, read from your own sale flyer / posts — the owner's
  // side of any "which items am I cheaper/pricier on?" question. Kept separate from
  // rivals so the assistant never confuses your prices for a competitor's.
  const ownPriced = [...arr(goals.myFlyerDeals?.deals)].sort((a, b) => rank(a) - rank(b))
    .map((d: any) => `- ${clean(d.item)}${d.price ? ` — ${clean(d.price)}` : ""}`).filter((x) => x.length > 3)
    .slice(0, qWords.length ? 45 : 20);
  push("Your advertised prices (from your own flyer/posts)", ownPriced);
  const priced = [...flyer].sort((a, b) => rank(a) - rank(b))
    .map((d) => `- ${clean(d.rival)}: ${clean(d.item)}${d.price ? ` — ${clean(d.price)}` : ""}`).filter((x) => x.length > 4)
    .slice(0, qWords.length ? 45 : 24);
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

  // what their photos/posts show — non-price visual context read from images
  const vis = arr(goals.visuals?.businesses)
    .filter((b: any) => arr(b.notes).length)
    .slice(0, 6)
    .map((b: any) => `- ${clean(b.name)}${b.isYou ? " (you)" : ""}: ${arr(b.notes).slice(0, 4).map(clean).join("; ")}`);
  push("What their photos/posts show (visual read)", vis);

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
    answer: { type: "string", description: "The reply in a warm, natural assistant voice — like texting the owner. LEAD with the direct answer to their question, then the specifics (real names + exact numbers). Plain text only (no markdown symbols); short line breaks are fine for a quick list. NEVER write [L…] citation labels in this text — sources are shown separately." },
    grounded: { type: "boolean", description: "true only if DATA actually contained what was needed to answer; false if you had to say you don't have it." },
    sourceIds: { type: "array", items: { type: "string" }, description: "The [Ln] labels of the LIVE RECORDS you relied on for SPECIFIC facts — they populate the Sources panel shown UNDER the reply, so never also write them in the answer text. Empty for general advice, moves, or summary-only answers." },
    action: {
      type: "object", additionalProperties: false,
      description: "Set ONLY when the owner explicitly asks to change a setting or remove a competitor. Otherwise omit it entirely (or kind='none').",
      properties: {
        kind: { type: "string", enum: ["none", "set_notify_email", "set_notify_whatsapp", "link_rani_store", "remove_competitor"] },
        email: { type: "string" },
        phone: { type: "string" },
        slug: { type: "string", description: "The Ask Rani store slug/name to link." },
        name: { type: "string", description: "The competitor name to remove." },
      },
      required: ["kind"],
    },
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
  `1b. PRICE QUESTIONS — be precise about WHOSE prices you have. "Your advertised prices" are the OWNER'S own; "Competitor prices" and "You vs rivals on price" are the market. If you have rivals' prices but the owner has no advertised price for the item in question, do NOT say "no prices were collected" — say what you DO have (name a couple of the competitor prices) and that you'd need the owner's own price for that item to compare. When the owner's own prices ARE present, use them together with rivals' to answer "which items am I cheaper/pricier on?".\n` +
  `2. COMBINE INSIDE + OUTSIDE. When the owner asks what to do / for a move, promo, campaign, or idea: give ONE or TWO concrete moves. Ground the rationale in real data — cross-reference YOUR OPERATIONS with the market: e.g., don't cut price on a best-seller even if a rival is cheaper; if a rival is winning something your OWN customers keep asking for, that's a strong signal; and if they have promote-and-earn advocates or a loyalty list, prefer ACTIVATING those (a zero-cost channel their own customers power) over matching rivals' paid ads. Time it to a relevant UPCOMING OCCASION when one fits. The creative idea is yours, but every fact must trace to DATA. Set grounded=true when built on real data.\n` +
  `3. VOICE — reply like a real assistant texting the owner: warm, natural, direct. OPEN with the actual answer to their question in the first sentence, then the specifics (real names, exact numbers). Keep it tight and human, not a report — no headers, no markdown symbols, no filler, no forced "let me know if…". For several prices/items, a short line-separated list reads cleaner than a run-on sentence.\n` +
  `3b. LANGUAGE — reply in the SAME language the owner wrote in (Spanish, Hindi, Hinglish, Telugu, Tamil, etc.), sounding natural to a native speaker. But keep business names, item names, and prices EXACTLY as they appear in the DATA — never translate or convert those.\n` +
  `4. SOURCES: LIVE RECORDS are labelled [L1], [L2], … Put the labels you relied on for SPECIFIC facts (an exact price, a specific post/change) in sourceIds so the app can list them under your reply — but do NOT write [L…] anywhere in the answer text itself. Only for specific facts, never for general advice, ideas, occasion timing, or SUMMARIES; at most 3.\n` +
  `5. RECENT CONVERSATION (if given) is only for follow-up context, not facts.\n` +
  `6. ACTIONS — you can make a few changes for the owner. ONLY when they explicitly ask, set "action": to send their reports to an email → kind="set_notify_email", email=<address>; to send reports to a WhatsApp number → kind="set_notify_whatsapp", phone=<number>; to connect their Ask Rani store so their own store data + shared credits link up → kind="link_rani_store", slug=<store name/slug they gave>; to stop watching a competitor → kind="remove_competitor", name=<competitor>. When you set an action, write a short answer CONFIRMING it's done (e.g. "Done — reports will go to …") and set grounded=true. For everything else omit action (or kind="none"). NEVER invent an action they didn't ask for.`;

/** Defensively turn the model's raw action object into a typed, validated action
 *  (or null). We never trust the model to produce a well-formed side effect. */
function validateAction(a?: Record<string, string> | null): AssistantAction | null {
  if (!a || typeof a !== "object") return null;
  const kind = String(a.kind ?? "").trim();
  const s = (v?: string) => String(v ?? "").trim();
  if (kind === "set_notify_email") { const email = s(a.email).toLowerCase(); return email.includes("@") ? { kind, email } : null; }
  if (kind === "set_notify_whatsapp") { const d = s(a.phone).replace(/\D/g, ""); return d.length >= 8 ? { kind, phone: `+${d}` } : null; }
  if (kind === "link_rani_store") { const slug = s(a.slug); return slug ? { kind, slug } : null; }
  if (kind === "remove_competitor") { const name = s(a.name); return name ? { kind, name } : null; }
  return null;
}

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

  const summaries = buildKnowledge(ws, goals, q);
  let liveText = "";
  let liveSources: RetrievedSource[] = [];
  if (svc && ws.id) {
    try { const lc = await retrieveLiveContext(svc, { id: ws.id, target_business_id: ws.target_business_id ?? null }, q); liveText = lc.text; liveSources = lc.sources; }
    catch { /* pillars still cover it */ }
  }

  // INSIDE view — the business's own Rani operations (best-sellers, promos, loyalty, promote-and-earn)
  let opsText = "";
  try { opsText = (await fetchRaniOps(ws, goals)).text; } catch { /* umbrella not wired — market-only */ }

  // NOTE: we no longer short-circuit when there's no market data — the copilot must
  // still handle CONFIG requests ("email my reports to…", "connect my Rani store…")
  // for a brand-new workspace. The friendly "nothing collected yet" nudge is applied
  // AFTER the brain runs, only when the message wasn't a config action (see below).
  const noData = !summaries.trim() && !liveText.trim() && !opsText.trim();

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
    const { data } = await getLlm().callStructured<{ answer: string; grounded: boolean; sourceIds?: string[]; action?: Record<string, string> }>({
      system: SYSTEM(ws),
      text: `DATA (real, recently collected for ${ws.name}):\n${dataText}${historyText}\nOWNER'S QUESTION: ${q}`,
      schema: SCHEMA, tier: "extract", maxTokens: 550,
    });
    const action = validateAction(data.action);

    // Brand-new workspace with nothing collected yet: if this wasn't a config
    // action, give the friendly nudge (config actions still go through below).
    if (noData && !action) {
      return { answer: `I don't have any market data collected for ${ws.name} yet — once a scan runs, ask me about competitor deals, prices, your rating, or what to run next. (I can still change your settings whenever you ask.)`, grounded: false };
    }

    const raw = clean(data.answer);
    if (!raw) return { answer: "I couldn't put that together — try rephrasing?", grounded: false, ...(action ? { action } : {}) };

    // cited ids = the structured field ∪ any citation markers the model left inline,
    // in EITHER form ([L9] or a bare [9]) — normalize both to the Ln id for the panel.
    const cited = new Set<string>((Array.isArray(data.sourceIds) ? data.sourceIds : []).map((s) => { const n = String(s).match(/\d+/); return n ? `L${n[0]}` : String(s).trim(); }));
    for (const m of raw.matchAll(/\[\s*(?:L\s*)?\d+(?:\s*,\s*(?:L\s*)?\d+)*\s*\]/gi)) { for (const num of m[0].match(/\d+/g) ?? []) cited.add(`L${num}`); }
    // strip ALL citation brackets ([L9], [9], [2, 9]) from the shown text so it reads
    // like a real reply, not a research paper — the Sources panel shows them instead.
    const answer = raw.replace(/\s*\[\s*(?:L\s*)?\d+(?:\s*,\s*(?:L\s*)?\d+)*\s*\]/gi, "").replace(/\s{2,}/g, " ").replace(/\s+([.,!?])/g, "$1").trim();

    const byId = new Map(liveSources.map((s) => [s.id, s]));
    const sources: ChatSource[] = [...cited].map((id) => byId.get(id)).filter((s): s is RetrievedSource => !!s)
      .slice(0, 3).map((s) => ({ label: s.label, business: s.business, platform: s.platform, url: s.url }));

    return { answer: answer || raw, grounded: !!data.grounded, ...(sources.length ? { sources } : {}), ...(action ? { action } : {}) };
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
