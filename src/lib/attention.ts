import { createServiceClient } from "@/lib/supabase/server";
import { buildDigest, type DigestItem, type ActSpec } from "@/lib/digest";
import { OBJECTIVES, type AttnMode } from "@/lib/attention-prefs";

/**
 * The attention layer — the brain of the brief. It takes the signals we already
 * generate (the deterministic digest across every pillar, plus the two pricing
 * signals the digest misses — your price gaps and competitor flyer price-drops),
 * RE-RANKS them competitor-&-pricing-first (what owners actually check daily),
 * and returns the 2-4 that need attention now + everything else as a "steady"
 * count. PURE + deterministic — no LLM, no new scrape, no cost, no failure mode —
 * so it's safe to run on read, on a cron, and inside the email/WhatsApp brief.
 *
 * This does NOT replace the pillars or the digest; it selects and ranks their
 * output into a decision surface. Cached on workspace.goals.attention.
 */

export type AttnClass = "A" | "B" | "C"; // A = needs attention, B = opportunity, C = context
export type AttnKind =
  | "competitor_price" | "your_pricing" | "competitor_deal" | "competitor_launch"
  | "reputation" | "findability" | "social" | "demand" | "menu" | "ads" | "content" | "listings" | "other";

export interface AttentionItem {
  id: string;
  cls: AttnClass;
  kind: AttnKind;
  label: string;        // "High impact" | "Opportunity" | "Watch"
  category: string;     // "Competitor price cut" etc. — the human sub-label
  icon: string;
  headline: string;     // the finding
  take: string;         // Rani's plain-language read / move
  actions: string[];    // suggested action labels for the UI
  act?: ActSpec;        // one-tap act spec (reply/promo/content) — reused from the digest
  href?: string;        // drill-down
  isNew?: boolean;
  score: number;
}

export interface AttentionBoard {
  headline: string;     // "3 things need your attention"
  statusLine: string;   // "3 need attention · 2 opportunities · 18 more steady"
  items: AttentionItem[]; // top 2-4 (class A/B), competitor & pricing first
  more: AttentionItem[];  // everything else, ranked — feeds the "everything moving" board
  stableCount: number;    // count of checked-but-steady signals
  checkedCount: number;   // total signals Rani weighed
  mode?: AttnMode;        // the attention mode this board was built under
  objective?: string;     // the owner's current focus (biases the ranking)
  at: string;
  empty?: boolean;
}

// Competitor & pricing lead — that's what owners told us they check daily.
const KIND_WEIGHT: Record<AttnKind, number> = {
  competitor_price: 100, your_pricing: 92, competitor_deal: 84, competitor_launch: 82,
  reputation: 66, findability: 60, demand: 54, menu: 52, social: 46, ads: 44,
  listings: 34, content: 26, other: 30,
};
const CLS_BASE: Record<AttnClass, number> = { A: 30, B: 12, C: 0 };
const LABEL: Record<AttnClass, string> = { A: "High impact", B: "Opportunity", C: "Watch" };

// ── Phase 5: the learning layer ───────────────────────────────────────────
export type { AttnMode };
export interface AttentionPrefs {
  objective?: string;                               // an OBJECTIVES slug — biases ranking
  mode?: AttnMode;                                  // how much surfaces (default "balanced")
  feedback?: { byKind?: Record<string, number> };   // learned net signal per kind
}
// Objective → a boost to the kinds that serve that goal, so a margin-focused owner
// sees pricing first, a reviews-focused owner sees reputation first, and so on.
const OBJECTIVE_BOOST: Record<string, Partial<Record<AttnKind, number>>> = {
  protect_margin: { your_pricing: 26, competitor_price: 20, competitor_deal: 12 },
  more_traffic: { competitor_deal: 14, competitor_launch: 14, social: 12, findability: 16 },
  grow_sales: { your_pricing: 14, menu: 16, demand: 16, competitor_deal: 12 },
  more_reviews: { reputation: 30 },
  get_discovered: { findability: 30, ads: 10 },
};
// Attention mode → how much surfaces. Quiet only interrupts for high-impact;
// Active shows the fuller picture.
const MODE_SELECT: Record<AttnMode, { classes: AttnClass[]; cap: number }> = {
  quiet: { classes: ["A"], cap: 2 },
  balanced: { classes: ["A", "B"], cap: 4 },
  active: { classes: ["A", "B", "C"], cap: 6 },
};
// Feedback weights — a "not useful" nudges a whole KIND down, "acted" strongly up.
// Clamped so no single tap is permanent, but repeated ones make Rani quieter there.
const FEEDBACK_WEIGHT: Record<string, number> = { useful: 6, acted: 12, not_useful: -8, dismiss: -12 };
const clampFb = (v?: number): number => Math.max(-40, Math.min(40, v ?? 0));

const clean = (s: unknown) => String(s ?? "").replace(/<\/?[a-z][^>]*>/gi, "").replace(/\s+/g, " ").trim();
const parseUsd = (s?: string): number | null => { const m = String(s ?? "").match(/\$?\s*(\d+(?:\.\d+)?)/); return m ? Number(m[1]) : null; };

// Map the digest's source pillar → an attention kind, so we can re-rank across sources.
const PILLAR_KIND: Record<string, AttnKind> = {
  "Competitor deals": "competitor_deal", "Competitor pricing": "competitor_deal",
  "Reputation": "reputation", "Listings": "listings",
  "Findability": "findability", "Social": "social", "Competitor ads": "ads",
  "Unmet demand": "demand", "What's winning": "menu", "Content": "content",
};
const clsFromSeverity = (sev: DigestItem["severity"]): AttnClass => (sev === "alert" ? "A" : sev === "opportunity" ? "B" : "C");

function actionsFor(kind: AttnKind, act?: ActSpec): string[] {
  switch (kind) {
    case "competitor_price": return ["Compare prices", "Create a counter-offer", "Watch"];
    case "your_pricing": return ["See comparison", "What would you do?"];
    case "competitor_deal": return ["Create a deal", "Compare", "Ignore"];
    case "competitor_launch": return ["Build my version", "Ignore"];
    case "reputation": return act?.kind === "reply" ? ["Reply", "Ignore"] : ["Post about it", "See"];
    case "findability": return ["Improve my page", "See searches"];
    case "social": return ["Make my version", "Ignore"];
    case "demand": return ["Promote it", "Ignore"];
    case "menu": return ["Announce it", "Ignore"];
    case "ads": return ["Create a promo", "Ignore"];
    case "listings": return ["Claim listing"];
    case "content": return ["Create post", "Ignore"];
    default: return ["See", "Ignore"];
  }
}

function recencyBoost(iso?: string, now = Date.now()): number {
  if (!iso) return 0;
  const t = new Date(iso).getTime();
  if (isNaN(t)) return 0;
  const days = (now - t) / 86_400_000;
  return days <= 1 ? 16 : days <= 3 ? 10 : days <= 7 ? 4 : 0;
}

function toItem(base: Omit<AttentionItem, "score" | "label">, now = Date.now()): AttentionItem {
  const label = LABEL[base.cls];
  const score = KIND_WEIGHT[base.kind] + CLS_BASE[base.cls] + (base.isNew ? 14 : 0);
  return { ...base, label, score: Math.round(score * 10) / 10 + recencyBoost(undefined, now) };
}

/** Deterministic build from a workspace's cached goals. Same goals in → same board out. */
export function buildAttention(
  ws: { name: string; vertical: string },
  goals: Record<string, any>,
  seenIds: string[] = [],
  now = new Date(),
): AttentionBoard {
  const at = now.toISOString();
  const seen = new Set(seenIds);
  // Phase 5 — learned prefs: objective bias + attention mode + per-kind feedback.
  const prefs = (goals.attentionPrefs ?? {}) as AttentionPrefs;
  const mode: AttnMode = prefs.mode === "quiet" || prefs.mode === "active" ? prefs.mode : "balanced";
  const objBoost = prefs.objective ? (OBJECTIVE_BOOST[prefs.objective] ?? {}) : {};
  const fb = prefs.feedback?.byKind ?? {};
  const cands: AttentionItem[] = [];

  // 1) Reuse the digest — it already gathers every pillar with act specs + severity.
  for (const d of buildDigest(ws, goals, seenIds, now).items) {
    const kind = PILLAR_KIND[d.pillar] ?? "other";
    const cls = clsFromSeverity(d.severity);
    cands.push(toItem({
      id: d.id, cls, kind, category: d.pillar, icon: d.icon,
      headline: d.title, take: d.detail, actions: actionsFor(kind, d.act),
      act: d.act, href: d.href, isNew: d.isNew,
    }));
  }

  // 2) Your price gaps (goals.priceGaps) — the "you vs rivals on price" the digest omits.
  for (const g of ((goals.priceGaps?.gaps ?? []) as any[]).slice(0, 4)) {
    const item = clean(g.item); if (!item) continue;
    const undercut = g.verdict === "undercut";
    const absent = g.verdict === "you_absent";
    if (g.verdict === "you_cheaper") continue; // a win — not something that "needs attention"
    const id = `pricegap:${g.verdict}:${item.slice(0, 30).toLowerCase()}`;
    cands.push(toItem({
      id, cls: undercut ? "A" : "B", kind: "your_pricing", category: "Your pricing", icon: undercut ? "⚖️" : "🏷️",
      headline: undercut ? `You're higher on ${item}` : `Rivals price ${item}, you don't`,
      take: clean(g.note) + (g.action ? ` — ${clean(g.action)}` : ""),
      actions: actionsFor("your_pricing"),
      act: g.action ? { kind: "promo", move: clean(g.action), context: `${item}: ${clean(g.note)}` } : undefined,
      href: "/offers", isNew: !seen.has(id),
    }, now.getTime()));
  }

  // 3) Competitor flyer price-DROPS (goals.flyerDeals) — the "rival cut X" moves owners
  //    told us they check first. Detect from the itemized flyer history we already store.
  const flyer = (goals.flyerDeals?.deals ?? []) as any[];
  const hist = new Map<string, { price: number; seen: number; rival: string; item: string }[]>();
  for (const d of flyer) {
    const n = parseUsd(d.price); if (n == null) continue;
    const rival = clean(d.rival), item = clean(d.item); if (!rival || !item) continue;
    const key = `${rival}|${item}`.toLowerCase();
    const t = new Date(d.seenAt ?? d.postedAt ?? 0).getTime();
    (hist.get(key) ?? hist.set(key, []).get(key)!).push({ price: n, seen: t, rival, item });
  }
  const drops: { rival: string; item: string; from: number; to: number; when?: number }[] = [];
  for (const arr of hist.values()) {
    if (arr.length < 2) continue;
    arr.sort((a, b) => a.seen - b.seen);
    const latest = arr[arr.length - 1];
    const priorMin = Math.min(...arr.slice(0, -1).map((x) => x.price));
    if (latest.price < priorMin) drops.push({ rival: latest.rival, item: latest.item, from: priorMin, to: latest.price, when: latest.seen });
  }
  for (const dp of drops.sort((a, b) => (b.from - b.to) - (a.from - a.to)).slice(0, 3)) {
    const id = `pricedrop:${dp.rival.toLowerCase()}:${dp.item.slice(0, 24).toLowerCase()}`;
    const cut = (dp.from - dp.to).toFixed(2);
    cands.push({
      ...toItem({
        id, cls: "A", kind: "competitor_price", category: "Competitor price cut", icon: "📉",
        headline: `${dp.rival} dropped ${dp.item} to $${dp.to.toFixed(2)}`,
        take: `Was $${dp.from.toFixed(2)} — a $${cut} cut. Rani's read: check if it's a promo before you chase it.`,
        actions: actionsFor("competitor_price"),
        href: "/offers", isNew: !seen.has(id),
      }, now.getTime()),
      score: KIND_WEIGHT.competitor_price + CLS_BASE.A + (seen.has(id) ? 0 : 14) + recencyBoost(new Date(dp.when ?? 0).toISOString(), now.getTime()),
    });
  }

  // Phase 5: bias each candidate by the owner's objective + what they've marked
  // (not) useful for that kind. Repeated "not useful" pushes a whole kind down.
  for (const c of cands) c.score += (objBoost[c.kind] ?? 0) + clampFb(fb[c.kind]);

  // Dedup (a rival deal can appear from both the digest and a price-drop) + rank.
  const byId = new Map<string, AttentionItem>();
  for (const c of cands) { const prev = byId.get(c.id); if (!prev || c.score > prev.score) byId.set(c.id, c); }
  const ranked = [...byId.values()].sort((a, b) => b.score - a.score || Number(!!b.isNew) - Number(!!a.isNew));

  // Surface per the attention MODE: quiet interrupts less (A only, 2), active more.
  const sel = MODE_SELECT[mode];
  const surfaced = ranked.filter((r) => sel.classes.includes(r.cls)).slice(0, sel.cap);
  const surfacedIds = new Set(surfaced.map((s) => s.id));
  const more = ranked.filter((r) => !surfacedIds.has(r.id));

  const aCount = surfaced.filter((i) => i.cls === "A").length;
  const bCount = surfaced.filter((i) => i.cls === "B").length;
  const stableCount = more.length;
  const headline =
    aCount > 0 ? `${aCount} thing${aCount > 1 ? "s" : ""} need${aCount > 1 ? "" : "s"} your attention`
    : bCount > 0 ? `${bCount} opportunit${bCount > 1 ? "ies" : "y"} for you`
    : "You're all caught up";
  const parts: string[] = [];
  if (aCount) parts.push(`${aCount} need${aCount > 1 ? "" : "s"} attention`);
  if (bCount) parts.push(`${bCount} opportunit${bCount > 1 ? "ies" : "y"}`);
  parts.push(`${stableCount} more checked, steady`);
  const statusLine = parts.join(" · ");

  return {
    headline, statusLine, items: surfaced, more,
    stableCount, checkedCount: ranked.length, at,
    mode, objective: prefs.objective,
    ...(surfaced.length ? {} : { empty: true }),
  };
}

/** Read-side: build from the current cache and store on goals.attention. Deterministic + cheap. */
export async function getOrMakeAttention(ws: { id: string; name: string; vertical: string }): Promise<AttentionBoard> {
  const svc = createServiceClient();
  const { data } = await svc.from("workspace").select("goals").eq("id", ws.id).maybeSingle();
  const goals = (data?.goals as Record<string, any>) ?? {};
  const board = buildAttention(ws, goals, (goals.attentionSeen?.ids as string[]) ?? []);
  await svc.from("workspace").update({ goals: { ...goals, attention: board } }).eq("id", ws.id).then(() => {}, () => {});
  return board;
}

/** Mark the current items as seen so the next brief only flags what's new. */
export async function markAttentionSeen(wsId: string, ids: string[], now = new Date()): Promise<void> {
  const svc = createServiceClient();
  const { data } = await svc.from("workspace").select("goals").eq("id", wsId).maybeSingle();
  const goals = (data?.goals as Record<string, any>) ?? {};
  await svc.from("workspace").update({ goals: { ...goals, attentionSeen: { ids, at: now.toISOString() } } }).eq("id", wsId);
}

// ── Phase 5 prefs writes (read-modify-write on goals.attentionPrefs) ────────
async function patchPrefs(wsId: string, fn: (p: AttentionPrefs) => AttentionPrefs): Promise<void> {
  const svc = createServiceClient();
  const { data } = await svc.from("workspace").select("goals").eq("id", wsId).maybeSingle();
  const goals = (data?.goals as Record<string, any>) ?? {};
  const prefs = fn((goals.attentionPrefs ?? {}) as AttentionPrefs);
  await svc.from("workspace").update({ goals: { ...goals, attentionPrefs: prefs } }).eq("id", wsId).then(() => {}, () => {});
}

/** Set the owner's objective (biases ranking). Pass null to clear. */
export async function setAttentionObjective(wsId: string, objective: string | null): Promise<void> {
  const valid = objective && OBJECTIVES.some((o) => o.slug === objective) ? objective : undefined;
  await patchPrefs(wsId, (p) => ({ ...p, objective: valid }));
}

/** Set the attention mode (quiet / balanced / active). */
export async function setAttentionMode(wsId: string, mode: AttnMode): Promise<void> {
  const valid: AttnMode = mode === "quiet" || mode === "active" ? mode : "balanced";
  await patchPrefs(wsId, (p) => ({ ...p, mode: valid }));
}

/** Record feedback on a KIND — the learning signal that makes Rani quieter (or
 *  louder) about that kind over time. */
export async function recordAttentionFeedback(wsId: string, kind: string, signal: keyof typeof FEEDBACK_WEIGHT): Promise<void> {
  const w = FEEDBACK_WEIGHT[signal] ?? 0;
  if (!w) return;
  await patchPrefs(wsId, (p) => {
    const byKind = { ...(p.feedback?.byKind ?? {}) };
    byKind[kind] = clampFb((byKind[kind] ?? 0) + w);
    return { ...p, feedback: { byKind } };
  });
}
