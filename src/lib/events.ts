import { createServiceClient } from "@/lib/supabase/server";

/**
 * Event & significance detection (guide §5 DetectChangesAndEvents, Appendix B).
 * Diffs the two most recent offer batches for a business (a "batch" = all offers
 * written in one collection run, keyed by observed_at) and emits market_event
 * rows describing what changed: new items, price moves, promotions starting,
 * items disappearing.
 *
 * Caveat handled here: model extraction is somewhat non-deterministic run to
 * run, so we damp the noise — price events need a meaningful % move, new-item
 * events need a confident extraction, and disappearances are low-significance.
 */

type Svc = ReturnType<typeof createServiceClient>;

const PROMO = new Set(["sale", "combo", "happy_hour", "prix_fixe", "buffet", "multi_buy", "bogo"]);
const MIN_PRICE_PCT = 0.05; // ignore sub-5% wobble
const NEW_ITEM_CONF = 0.6; // only announce new items we're reasonably sure of

interface OfferLite {
  entity: string;
  amount: number | null;
  offerType: string;
  confidence: number;
}
interface MarketEventRow {
  workspace_id: string;
  business_id: string;
  event_group: string;
  event_type: string;
  significance: number;
  summary: string;
  details: Record<string, unknown>;
  time_start: string;
}

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9 ]/g, "").replace(/\s+/g, " ").trim();
const money = (n: number | null) => (n == null ? "?" : `$${n}`);

export async function detectEventsForBusiness(
  businessId: string,
  workspaceId: string,
  vertical = "restaurant",
): Promise<number> {
  const svc = createServiceClient();

  const { data: rowsRaw } = await svc
    .from("offer")
    .select("entity_text,offer_type,pricing,confidence,observed_at")
    .eq("business_id", businessId)
    .order("observed_at", { ascending: false })
    .limit(600);
  const rows = (rowsRaw ?? []) as any[];
  if (rows.length === 0) return 0;

  // distinct batches (collection runs) by observed_at, newest first
  const batchTimes = [...new Set(rows.map((r) => r.observed_at as string))];
  if (batchTimes.length < 2) return 0; // need history to detect change

  const [curTs, prevTs] = batchTimes;
  const toMap = (ts: string) => {
    const m = new Map<string, OfferLite>();
    for (const r of rows.filter((x: any) => x.observed_at === ts)) {
      const key = norm(r.entity_text as string);
      if (!key) continue;
      const amount = (r.pricing as any)?.amount ?? null;
      // keep the highest-confidence instance of a repeated entity in a batch
      const prev = m.get(key);
      const cand: OfferLite = { entity: r.entity_text as string, amount, offerType: r.offer_type as string, confidence: Number(r.confidence) };
      if (!prev || cand.confidence > prev.confidence) m.set(key, cand);
    }
    return m;
  };
  const cur = toMap(curTs);
  const prev = toMap(prevTs);

  const newItemType = vertical === "grocery" ? "new_product" : vertical === "salon" ? "new_treatment" : "new_dish";
  const events: MarketEventRow[] = [];
  const base = (event_group: string, event_type: string, significance: number, summary: string, details: Record<string, unknown>): MarketEventRow => ({
    workspace_id: workspaceId,
    business_id: businessId,
    event_group,
    event_type,
    significance: Number(Math.max(0, Math.min(1, significance)).toFixed(3)),
    summary,
    details,
    time_start: curTs,
  });

  for (const [key, c] of cur) {
    const p = prev.get(key);
    if (!p) {
      if (c.confidence >= NEW_ITEM_CONF) {
        if (PROMO.has(c.offerType)) {
          // a brand-new promotional offer reads as a promotion starting
          events.push(base("promotion", "sale_started", 0.7, `New promotion: ${c.entity}${c.amount != null ? ` (${money(c.amount)})` : ""}`, { entity: c.entity, offer_type: c.offerType, amount: c.amount }));
        } else {
          events.push(base("offering", newItemType, 0.5, `New: ${c.entity}${c.amount != null ? ` (${money(c.amount)})` : ""}`, { entity: c.entity, amount: c.amount }));
        }
      }
      continue;
    }
    // price movement
    if (c.amount != null && p.amount != null && p.amount > 0) {
      const pct = (c.amount - p.amount) / p.amount;
      if (Math.abs(pct) >= MIN_PRICE_PCT) {
        const down = pct < 0;
        events.push(
          base(
            "price",
            down ? "price_decrease" : "price_increase",
            Math.min(1, Math.abs(pct) * 2 + 0.3),
            `${c.entity} price ${down ? "dropped" : "rose"} ${Math.abs(Math.round(pct * 100))}% (${money(p.amount)} -> ${money(c.amount)})`,
            { entity: c.entity, before: p.amount, after: c.amount, pct: Number(pct.toFixed(3)) },
          ),
        );
      }
    }
    // promotion started (regular → promo type)
    if (PROMO.has(c.offerType) && !PROMO.has(p.offerType)) {
      events.push(base("promotion", "sale_started", 0.7, `Started a promotion: ${c.entity} (${c.offerType.replace("_", " ")})`, { entity: c.entity, offer_type: c.offerType }));
    }
  }

  for (const [key, p] of prev) {
    if (!cur.has(key)) {
      events.push(base("offering", "menu_removed", 0.3, `No longer listed: ${p.entity}`, { entity: p.entity }));
    }
  }

  // idempotent for this batch: replace any events already detected at curTs
  await svc.from("market_event").delete().eq("business_id", businessId).eq("time_start", curTs);
  if (events.length) {
    const { error } = await svc.from("market_event").insert(events);
    if (error) throw new Error(`market_event insert: ${error.message}`);
  }
  return events.length;
}
