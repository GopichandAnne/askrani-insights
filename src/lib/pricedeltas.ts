import { createServiceClient } from "@/lib/supabase/server";
import { isLiveDeal, type DatedDeal } from "@/lib/dealfreshness";

/**
 * Week-over-week price DELTAS — the "a rival just CUT (or raised) X" signal.
 *
 * A current price is a static fact; a price CHANGE is a competitive EVENT — the
 * actual move an owner reacts to. We already have the history to detect it with no
 * new scrape: mergeDeals (flyers.ts) keys deals by `rival|item|price`, so when a
 * rival re-prices an item the OLD and NEW prices both persist in
 * goals.flyerDeals.deals, each date-stamped. This turns that itemized history into
 * ranked price moves.
 *
 * PURE + deterministic — no LLM, no new scrape, no cost, no new storage; computed
 * on read from the already-cached flyers. Two guardrails make it trustworthy:
 *  1) Units + pack size are part of the identity — $/lb only compares to $/lb, and
 *     a 40LB rice never compares to a 25LB one (avoids the naive-parser false move).
 *  2) The NEWER price must still be live (reuses the deal-freshness gate) — we never
 *     announce a "cut" into a price whose sale window already expired.
 */

export type PriceDirection = "cut" | "hike";
export interface PriceMove {
  rival: string;
  item: string;
  unit: string;            // canonical unit the compare was made in ("lb", "ea", …)
  fromPrice: string;       // baseline, as printed
  toPrice: string;         // current, as printed
  fromValue: number;       // baseline per-unit numeric
  toValue: number;         // current per-unit numeric
  deltaPct: number;        // signed, rounded % change
  deltaAbs: number;        // signed per-unit $ change
  direction: PriceDirection;
  since?: string;          // when the baseline price was seen (ISO)
  at?: string;             // when the current price was seen (ISO)
  note: string;            // one-line, owner language
  action: string;          // the move for the owner
}
export interface PriceMoves { moves: PriceMove[]; at: string; empty?: boolean }

type PricedDeal = DatedDeal & { rival?: string; item?: string; price?: string };

const MIN_PCT = 8;         // ignore sub-8% wobble (rounding / weight noise)…
const MIN_ABS = 0.2;       // …unless the per-unit dollar move is at least this big
const round4 = (n: number) => Math.round(n * 10000) / 10000;
const clean = (s: unknown) => String(s ?? "").replace(/\s+/g, " ").trim();

/** Collapse a printed unit to a small canonical set so equivalents group together. */
function canonUnit(u?: string): string {
  const s = (u ?? "").toLowerCase().replace(/\.+$/, "").replace(/s$/, "");
  const map: Record<string, string> = {
    lb: "lb", pound: "lb", oz: "oz", ounce: "oz", kg: "kg", g: "g", gm: "g", gram: "g",
    ml: "ml", l: "l", liter: "l", litre: "l", ltr: "l",
    ct: "ct", count: "ct", pc: "ct", pcs: "ct", piece: "ct", pk: "pk", pack: "pk",
    ea: "ea", each: "ea", unit: "ea", session: "session", visit: "visit",
    mo: "mo", month: "mo", person: "person", dozen: "dozen", doz: "dozen",
  };
  return map[s] ?? (s || "ea");
}

interface ParsedPrice { value: number; unit: string }

/** Parse a printed price into a per-unit number + unit. Returns null for forms that
 *  can't be compared apples-to-apples (percent-off, BOGO, "from $X"). */
export function parsePrice(raw?: string): ParsedPrice | null {
  const t = (raw ?? "").toLowerCase().trim();
  if (!t) return null;
  // non-comparable forms — a % off, a BOGO, or an open-ended floor
  if (/%|\bbogo\b|buy\s*\d*\s*get|b\dg\d|\bfree\b|\bfrom\b|as\s+low\s+as|starting|call|tbd|market/.test(t)) return null;
  // unreadable price the vision read couldn't resolve ("$1.xx", "$_.__", "1.??") —
  // never treat these as a real number.
  if (/\d[._]\s*[x_?]|[x_?]\s*[._]\s*\d|\bx\.?x\b|\.xx/.test(t) || /\$\s*\d+\.\s*(?![\d])/.test(t)) return null;

  // multi-buy: "2 for $5", "3/$1", "6 for $1". The count must be a BARE small integer,
  // never the fractional part of a price (so "$9.99 / $5.99" is not read as "99 for $5.99").
  let m = t.match(/(?:^|[^\d.$])(\d{1,3})\s*(?:for|\/)\s*\$\s*(\d+(?:\.\d+)?)/);
  if (m) { const c = +m[1], p = +m[2]; return c > 0 && p > 0 ? { value: round4(p / c), unit: "ea" } : null; }
  // "$5 for 2"
  m = t.match(/\$\s*(\d+(?:\.\d+)?)\s*for\s*(\d+)/);
  if (m) { const p = +m[1], c = +m[2]; return c > 0 && p > 0 ? { value: round4(p / c), unit: "ea" } : null; }

  // dual "reg / sale" — two $ amounts (e.g. "$9.99 / $5.99") → the LOWER is the price
  // shoppers pay; carry a trailing "/unit" if the flyer printed one.
  const dollars = [...t.matchAll(/\$\s*(\d+(?:\.\d+)?)/g)].map((x) => +x[1]).filter((v) => v > 0);
  if (dollars.length >= 2) {
    const u = t.match(/\/\s*(?:\d+\s*)?([a-z]{2,10})\b/);
    return { value: round4(Math.min(...dollars)), unit: canonUnit(u?.[1]) };
  }

  // single "$M" with an optional "/[count] unit" (handles "$0.99/lb", "$0.99/2lb", "$0.99/10 piece", "$45/session")
  m = t.match(/\$\s*(\d+(?:\.\d+)?)\s*(?:\/|per\b)?\s*(?:(\d+)\s*)?([a-z]{1,10})?/);
  if (m) {
    const p = +m[1]; if (!(p > 0)) return null;
    const denom = m[2] ? +m[2] : 1;
    return { value: round4(denom > 0 ? p / denom : p), unit: canonUnit(m[3]) };
  }
  return null;
}

// Placeholder item names vision emits when a poster item has no readable label — never
// a real, comparable product, so they must not group into a "move".
const GENERIC_ITEM = new Set(["item", "product", "produce", "unlabeled", "assorted", "various", "misc", "sale", "special", "offer", "deal", "price", "combo", "na", "tbd"]);
function isGenericItem(norm: string): boolean {
  if (!norm || norm.length < 3) return true;
  return norm.split(" ").every((w) => GENERIC_ITEM.has(w));
}

/** Item identity for grouping across weeks: drop parenthetical qualifiers ("(Per LB)",
 *  "(Except …)"), keep real size tokens ("40LB") so different pack sizes stay distinct. */
function normItem(item: string): string {
  return item.toLowerCase().replace(/\([^)]*\)/g, " ").replace(/\s+/g, " ").trim();
}

/** Detect ranked week-over-week price moves from the itemized flyer history. */
export function detectPriceMoves(
  deals: PricedDeal[] | undefined,
  now: Date = new Date(),
  opts: { limit?: number } = {},
): PriceMoves {
  type Pt = { value: number; price: string; t: number; live: boolean };
  const groups = new Map<string, { rival: string; item: string; unit: string; pts: Pt[] }>();

  for (const d of deals ?? []) {
    const parsed = parsePrice(d.price); if (!parsed) continue;
    const rival = clean(d.rival), item = clean(d.item); if (!rival || !item) continue;
    const ni = normItem(item); if (isGenericItem(ni)) continue;
    const key = `${rival.toLowerCase()}|${ni}|${parsed.unit}`;
    const t = new Date(d.postedAt ?? d.seenAt ?? 0).getTime();
    const g = groups.get(key) ?? { rival, item, unit: parsed.unit, pts: [] };
    g.pts.push({ value: parsed.value, price: clean(d.price), t: isNaN(t) ? 0 : t, live: isLiveDeal(d, now) });
    groups.set(key, g);
  }

  const moves: PriceMove[] = [];
  for (const g of groups.values()) {
    if (g.pts.length < 2) continue;
    g.pts.sort((a, b) => a.t - b.t);
    const current = g.pts[g.pts.length - 1];
    if (!current.live) continue;                          // only report a move INTO a live price
    let baseline: Pt | undefined;                         // most recent PRIOR price that differs
    for (let i = g.pts.length - 2; i >= 0; i--) { if (g.pts[i].value !== current.value) { baseline = g.pts[i]; break; } }
    if (!baseline) continue;

    const deltaAbs = round4(current.value - baseline.value);
    const deltaPct = Math.round(((current.value - baseline.value) / baseline.value) * 100);
    if (Math.abs(deltaPct) < MIN_PCT && Math.abs(deltaAbs) < MIN_ABS) continue;

    const direction: PriceDirection = current.value < baseline.value ? "cut" : "hike";
    const pct = Math.abs(deltaPct);
    const note = direction === "cut"
      ? `${g.rival} cut ${g.item} ${pct}% — ${baseline.price} → ${current.price}`
      : `${g.rival} raised ${g.item} ${pct}% — ${baseline.price} → ${current.price}`;
    const action = direction === "cut"
      ? `Check if it's a one-week promo; if it holds, match ${g.item} or counter with a bundle before the weekend.`
      : `They're pricier on ${g.item} now — put your ${g.item} price in front of shoppers to win the switch.`;

    moves.push({
      rival: g.rival, item: g.item, unit: g.unit,
      fromPrice: baseline.price, toPrice: current.price,
      fromValue: baseline.value, toValue: current.value,
      deltaPct, deltaAbs, direction,
      since: baseline.t ? new Date(baseline.t).toISOString() : undefined,
      at: current.t ? new Date(current.t).toISOString() : undefined,
      note, action,
    });
  }

  // Cuts first (the sharper threat), then by magnitude.
  moves.sort((a, b) => (a.direction === b.direction ? Math.abs(b.deltaPct) - Math.abs(a.deltaPct) : a.direction === "cut" ? -1 : 1));
  const limited = moves.slice(0, opts.limit ?? 8);
  return { moves: limited, at: now.toISOString(), ...(limited.length ? {} : { empty: true }) };
}

/** Read-side: compute price moves from a workspace's cached flyer history (cheap, no cost). */
export async function getPriceMoves(ws: { id: string }): Promise<PriceMoves> {
  const svc = createServiceClient();
  const { data } = await svc.from("workspace").select("goals").eq("id", ws.id).maybeSingle();
  const deals = ((data?.goals as Record<string, any>)?.flyerDeals?.deals ?? []) as PricedDeal[];
  return detectPriceMoves(deals);
}
