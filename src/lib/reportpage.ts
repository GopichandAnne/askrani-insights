import { liveDeals } from "@/lib/dealfreshness";
import { detectPriceMoves, type PriceMove } from "@/lib/pricedeltas";

/**
 * Public report view-model — assembles the sendable market read (`/r/[token]`)
 * from a workspace's cached `goals`. PURE + defensive: every section is optional
 * and rendered only when the data backs it, so it works for any workspace we mint
 * a token for. No new scrape, no LLM — reads the pillars we already synthesized.
 */

export interface Standing { name: string; rating: number | null; reviews: number | null; isYou: boolean }
export interface BoardItem { label: string; price: string; free?: boolean }
export interface BoardCard { rival: string; note?: string; when?: string; items: BoardItem[]; aggressive?: boolean }
export interface MoveStat { v: string; k: string; hot?: boolean }
export interface CalendarEvent { when: string; title: string; detail: string; next?: boolean }
export interface ReportData {
  businessName: string;
  subline: string;
  dateLabel: string;
  position: { rating: number | null; rank: number | null; total: number | null; marketAvg: number | null; say: string; health?: string };
  move?: { title: string; detail: string; stats: MoveStat[] };
  standings: Standing[];
  board: { title: string; intro: string; cards: BoardCard[] };
  moves: { intro: string; rows: PriceMove[] } | null;
  reviews?: { love: string[]; watch: { theme: string; fix: string }[] };
  pulse?: string;
  calendar: CalendarEvent[];
}

const clean = (s: unknown) => String(s ?? "").replace(/<\/?[a-z][^>]*>/gi, "").replace(/\s+/g, " ").trim();
const GENERIC = new Set(["item", "product", "produce", "unlabeled", "assorted", "various", "misc", "sale", "special", "offer", "deal", "combo", "na", "tbd"]);
const isJunkItem = (s: string) => { const n = s.toLowerCase().replace(/\([^)]*\)/g, " ").replace(/\s+/g, " ").trim(); return !n || n.length < 2 || n.split(" ").every((w) => GENERIC.has(w)); };
const isFreebie = (s?: string) => /spend|free|\$\d+\+|liking|sharing|follow/i.test(s ?? "");

function dateLabel(now: Date): string {
  return now.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

/** Build the public report view-model from goals + fresh standings. */
export function buildPublicReport(
  ws: { name: string; vertical: string },
  goals: Record<string, any>,
  reviewCountByName: Record<string, number | null>,
  now: Date = new Date(),
): ReportData {
  const you = goals.you as any | undefined;
  const rep = you?.reputation ?? {};
  const syn = you?.synthesis ?? {};
  const disc = you?.discoverability?.scorePct ?? null;

  // ── standings (peers best-first) + review counts merged in ────────────────
  const peers: { name: string; rating: number; isTarget: boolean }[] = Array.isArray(rep.peers) ? rep.peers : [];
  const standings: Standing[] = peers.map((p) => ({
    name: clean(p.name),
    rating: typeof p.rating === "number" ? p.rating : null,
    reviews: reviewCountByName[clean(p.name)] ?? null,
    isYou: !!p.isTarget,
  }));
  const total = rep.total ?? standings.length ?? null;
  const rank = rep.rank ?? null;
  const marketAvg = rep.marketAvg ?? null;
  const you1 = standings.find((s) => s.isYou);

  // ── position hero ─────────────────────────────────────────────────────────
  const health = syn.health as string | undefined;
  const rankTop = rank === 1;
  const say = clean(syn.summary) ||
    (rankTop ? `You're the highest-rated ${ws.vertical} in your corridor — ${rep.rating ?? "?"}★ against a market average of ${marketAvg ?? "?"}★.`
             : `You're rated ${rep.rating ?? "?"}★${marketAvg != null ? ` vs a market average of ${marketAvg}★` : ""}.`);

  // ── the move ──────────────────────────────────────────────────────────────
  let move: ReportData["move"] | undefined;
  const counts = standings.filter((s) => typeof s.reviews === "number");
  const youReviews = you1?.reviews ?? rep.reviewCount ?? null;
  const leastReviewed = counts.length >= 2 && youReviews != null && counts.every((s) => s.isYou || (s.reviews ?? 0) >= youReviews);
  if (rankTop && leastReviewed) {
    const rivals = counts.filter((s) => !s.isYou).sort((a, b) => (b.reviews ?? 0) - (a.reviews ?? 0)).slice(0, 2);
    move = {
      title: `Make your ${rep.rating ?? ""}★ visible — ask happy customers for a Google review.`,
      detail: "You're the best-rated store in the market but the least-reviewed — so your quality is invisible to shoppers searching online. Closing that gap is the single highest-leverage thing you can do right now.",
      stats: [
        { v: String(youReviews), k: "your reviews", hot: true },
        ...rivals.map((r) => ({ v: (r.reviews ?? 0).toLocaleString(), k: `${r.name.split(/[·—-]/)[0].trim()}'s` })),
        ...(disc != null ? [{ v: `${disc}`, k: "search visibility /100" }] : []),
      ],
    };
  } else if (goals.edge?.headline) {
    move = { title: clean(goals.edge.headline), detail: clean(goals.edge.subhead) || clean(syn.summary) || "", stats: disc != null ? [{ v: `${disc}`, k: "search visibility /100", hot: true }] : [] };
  }

  // ── the weekend board (live rival deals grouped by rival) ─────────────────
  const live = liveDeals((goals.flyerDeals?.deals ?? []) as any[], now);
  const byRival = new Map<string, { items: BoardItem[]; latest: number; seen: Set<string> }>();
  for (const d of live) {
    const rival = clean(d.rival), item = clean(d.item); if (!rival || !item || isJunkItem(item)) continue;
    const g = byRival.get(rival) ?? { items: [], latest: 0, seen: new Set() };
    const key = item.toLowerCase(); if (g.seen.has(key)) continue; g.seen.add(key);
    const t = new Date(d.postedAt ?? d.seenAt ?? 0).getTime(); if (!isNaN(t)) g.latest = Math.max(g.latest, t);
    if (g.items.length < 6) g.items.push({ label: item, price: clean(d.price) || "—", free: isFreebie(d.price) || isFreebie(d.terms) });
    byRival.set(rival, g);
  }
  // ── price moves (computed before the board so we can flag the top cutter) ──
  const mv = detectPriceMoves((goals.flyerDeals?.deals ?? []) as any[], now).moves;
  const cutsByRival = new Map<string, number>();
  for (const m of mv) if (m.direction === "cut") cutsByRival.set(m.rival, (cutsByRival.get(m.rival) ?? 0) + 1);
  const topCutter = [...cutsByRival.entries()].sort((a, b) => b[1] - a[1])[0];
  const aggressiveRival = topCutter && topCutter[1] >= 2 ? topCutter[0] : null;

  const cards: BoardCard[] = [...byRival.entries()]
    .filter(([, g]) => g.items.length)
    .sort((a, b) => b[1].items.length - a[1].items.length)
    .slice(0, 4)
    .map(([rival, g]) => ({ rival, items: g.items.slice(0, 5), aggressive: rival === aggressiveRival }));
  const movesIntro = mv.length
    ? (topCutter && topCutter[1] >= 2
        ? `We flag when a rival changes a price — not just what it is. This week ${topCutter[0].split(/[·—-]/)[0].trim()} drove the cuts (${topCutter[1]} of them), all on price-check produce.`
        : "We flag when a rival changes a price — not just what it is. A cut is a move to answer; a hike is a chance to win the switch.")
    : "";

  // ── reviews ───────────────────────────────────────────────────────────────
  const love: string[] = (Array.isArray(syn.loves) ? syn.loves : []).map(clean).filter(Boolean).slice(0, 5);
  const watch = (Array.isArray(syn.gripes) ? syn.gripes : []).map((g: any) => ({ theme: clean(g.theme), fix: clean(g.fix) })).filter((g: any) => g.theme).slice(0, 3);
  const reviews = love.length || watch.length ? { love, watch } : undefined;

  // ── pulse ─────────────────────────────────────────────────────────────────
  const pulse = clean(goals.socialPulse?.summary) || undefined;

  // ── calendar (upcoming occasions) ─────────────────────────────────────────
  const calendar: CalendarEvent[] = ((goals.festival?.plans ?? []) as any[])
    .filter((p) => clean(p.occasion))
    .slice(0, 3)
    .map((p, i) => ({
      when: typeof p.inDays === "number" ? `in ${p.inDays} day${p.inDays === 1 ? "" : "s"}` : "upcoming",
      title: clean(p.occasion),
      detail: clean(p.why) || clean((p.moves ?? [])[0]) || "A fitting occasion is coming up — plan a campaign before it's here.",
      next: i === 0,
    }));

  const rivalN = Math.max(0, standings.length - 1);
  return {
    businessName: ws.name,
    subline: `${ws.vertical.charAt(0).toUpperCase() + ws.vertical.slice(1)} — you vs the ${rivalN} nearest rival${rivalN === 1 ? "" : "s"} in your market.`,
    dateLabel: dateLabel(now),
    position: { rating: rep.rating ?? null, rank, total, marketAvg, say, health },
    move,
    standings,
    board: {
      title: "The current board",
      intro: cards.length ? "Here's what your rivals are advertising right now — match or beat it item-by-item." : "",
      cards,
    },
    moves: mv.length ? { intro: movesIntro, rows: mv.slice(0, 6) } : null,
    reviews,
    pulse,
    calendar,
  };
}
