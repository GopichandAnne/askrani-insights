import { staleCached } from "@/lib/staleCache";
import { createClient, type RlsClient } from "@/lib/supabase/server";
import { workspaceBusinessIds, type WorkspaceRow } from "@/lib/workspace";
import { pickCompetitivePrice, scopeForChannel, type ScopedOffer } from "@/lib/pricescope";

/**
 * Grocery price BATTLEGROUNDS — grocery competition is category/item-specific, not a
 * single "is X a competitor" verdict: Walmart may be a weak overall match but a fierce
 * price rival on a handful of staples; H Mart may only overlap on produce. This reads
 * the actual collected prices (offer table) for the target + each competitor, finds
 * the SHARED priced items, and reports where each rival undercuts you. Deterministic
 * price math — no LLM, no scrape. Grocery only; empty for other verticals.
 */
const norm = (s: unknown) => String(s ?? "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

export interface RivalBattle { name: string; overlap: number; cheaper: number; pricier: number; note: string }
export interface Battlegrounds { rivals: RivalBattle[]; summary: string; at: string; empty?: boolean }

const emptyBg = (at: string): Battlegrounds => ({ rivals: [], summary: "", at, empty: true });

export async function generateBattlegrounds(ws: WorkspaceRow, db?: RlsClient): Promise<Battlegrounds> {
  const at = new Date().toISOString();
  if (ws.vertical !== "grocery") return emptyBg(at);
  const supabase = db ?? (await createClient());
  const ids = await workspaceBusinessIds(ws, supabase);
  if (!ids.targetId || !ids.competitorIds.length) return emptyBg(at);

  const { data: offers } = await supabase
    .from("offer")
    .select("business_id, entity_text, pricing, provenance, observed_at, valid_to, validity_end")
    .in("business_id", [ids.targetId, ...ids.competitorIds])
    .order("observed_at", { ascending: false })
    .limit(5000);

  // Gather every priced offer per (business, item), then pick the COMPETITIVE price
  // via scope precedence — a branch's local flyer/delivery price beats the same
  // business's corporate-website list price (pricescope.ts). No overwriting.
  const bag = new Map<string, Map<string, ScopedOffer[]>>();
  for (const o of (offers ?? []) as any[]) {
    const amt = Number(o.pricing?.amount);
    if (!Number.isFinite(amt) || amt <= 0) continue;
    const item = norm(o.entity_text);
    if (!item || item.length < 3) continue;
    const prov = (o.provenance as any) ?? {};
    const m = bag.get(o.business_id) ?? bag.set(o.business_id, new Map()).get(o.business_id)!;
    (m.get(item) ?? m.set(item, []).get(item)!).push({
      amount: amt, scope: prov.scope ?? scopeForChannel(prov.channel), channel: prov.channel,
      observedAt: o.observed_at, validTo: o.valid_to, validityEnd: o.validity_end,
    });
  }
  const priceOf = new Map<string, Map<string, number>>();
  for (const [biz, items] of bag) {
    const m = new Map<string, number>();
    for (const [item, offs] of items) { const best = pickCompetitivePrice(offs); if (best) m.set(item, best.amount); }
    priceOf.set(biz, m);
  }
  const mine = priceOf.get(ids.targetId);
  if (!mine || mine.size === 0) return emptyBg(at);

  const { data: biz } = await supabase.from("business").select("id, canonical_name").in("id", ids.competitorIds);
  const nameById = new Map(((biz ?? []) as any[]).map((b) => [b.id as string, (b.canonical_name as string) ?? "Competitor"]));

  const rivals: RivalBattle[] = [];
  for (const cid of ids.competitorIds) {
    const theirs = priceOf.get(cid);
    if (!theirs || theirs.size === 0) continue;
    let overlap = 0, cheaper = 0, pricier = 0;
    for (const [item, myP] of mine) {
      const tp = theirs.get(item);
      if (tp == null) continue;
      overlap++;
      if (tp < myP * 0.98) cheaper++;
      else if (tp > myP * 1.02) pricier++;
    }
    if (overlap < 3) continue; // too few shared items to say anything
    const note = cheaper >= Math.max(3, Math.round(overlap * 0.4))
      ? `Undercuts you on ${cheaper} of ${overlap} shared items`
      : pricier > cheaper
        ? `You're cheaper on most of ${overlap} shared items`
        : `${overlap} shared priced items, prices close`;
    rivals.push({ name: nameById.get(cid) ?? "Competitor", overlap, cheaper, pricier, note });
  }
  rivals.sort((a, b) => b.cheaper - a.cheaper || b.overlap - a.overlap);
  if (!rivals.length) return emptyBg(at);

  const top = rivals[0];
  const summary = top.cheaper > 0
    ? `${top.name} is your sharpest price battleground — undercutting you on ${top.cheaper} shared item${top.cheaper === 1 ? "" : "s"}.`
    : `You hold price on most shared items across ${rivals.length} rival${rivals.length === 1 ? "" : "s"}.`;
  return { rivals: rivals.slice(0, 8), summary, at };
}

export function getOrMakeBattlegrounds(ws: WorkspaceRow, maxAgeHours = 12): Promise<Battlegrounds> {
  return staleCached(ws, "battlegrounds", maxAgeHours, () => generateBattlegrounds(ws), { isValid: (c) => !!c });
}
