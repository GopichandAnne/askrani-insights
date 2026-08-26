import { createClient, type RlsClient } from "@/lib/supabase/server";
import { workspaceBusinessIds, type WorkspaceRow } from "@/lib/workspace";
import { matchProcedure } from "@/lib/dentalbenchmark";

/**
 * Transparent-price ANCHORS + pricing-transparency intel (dental).
 *
 * Reality: 80–90% of private dental practices don't publish prices — but a
 * minority DO (corporate chains' new-patient specials, dental schools & public
 * clinics under transparency rules, and a few flat-rate independents). Those
 * published prices are REAL local anchors — higher confidence than a review
 * mention or the generic regional benchmark. We already extract them into the
 * `offer` table via the dental website module; this maps them onto benchmark
 * procedures and, as a bonus competitive signal, classifies WHO in the market
 * publishes prices vs. who's opaque (transparency itself is a differentiator).
 *
 * Deterministic — no LLM, no new scraping (pure read over data we already have).
 * Dental-only (procedure matching is CDT-shaped); cached on goals.priceAnchors.
 */

const CHAIN = /aspen dental|western dental|gentle dental|comfort dental|bright now|dental depot|smile brands|midwest dental|heartland dental|pacific dental|mint dentistry|dental ?works|monarch dental|great expressions|affordable dentures|castle dental|coast dental|sonrava|smile ?direct/i;
const SCHOOL = /universit|dental school|college of dentistry|school of dental|dental college|dental hygiene program/i;
const PUBLIC = /community health|health center|federally qualified|fqhc|public health|county health|free clinic|charitable/i;
export type ClinicType = "chain" | "school" | "public" | "independent";
function clinicType(name: string): ClinicType {
  if (SCHOOL.test(name)) return "school";
  if (PUBLIC.test(name)) return "public";
  if (CHAIN.test(name)) return "chain";
  return "independent";
}

const median = (xs: number[]): number => { const s = [...xs].sort((a, b) => a - b); const m = Math.floor(s.length / 2); return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };

export interface AnchorPrice { business: string; isYou: boolean; amount: number; type: ClinicType }
export interface ProcedureAnchor { key: string; label: string; low: number; high: number; median: number; prices: AnchorPrice[] }
export interface TransparencyRow { business: string; isYou: boolean; publishes: boolean; pricedItems: number; type: ClinicType }
export interface PriceAnchorsReport {
  at: string;
  anchors: ProcedureAnchor[];        // real published prices, mapped to procedures
  transparency: TransparencyRow[];   // who publishes prices vs. who's opaque
  publishedCount: number;            // competitors that publish (excl. you)
  opaqueCount: number;               // competitors that don't (excl. you)
  youPublish: boolean;
  summary: string;
  empty?: boolean;
}

const emptyReport = (at: string): PriceAnchorsReport => ({ at, anchors: [], transparency: [], publishedCount: 0, opaqueCount: 0, youPublish: false, summary: "", empty: true });

export async function buildPriceAnchors(ws: WorkspaceRow, db?: RlsClient): Promise<PriceAnchorsReport> {
  const at = new Date().toISOString();
  // Dental-only: the procedure matcher is CDT-shaped. Other verticals get nothing.
  if (ws.vertical !== "dental") return emptyReport(at);
  const supabase = db ?? (await createClient());
  const ids = await workspaceBusinessIds(ws, supabase);
  const scope = ids.all;
  if (!scope.length) return emptyReport(at);

  const [{ data: biz }, { data: offers }] = await Promise.all([
    supabase.from("business").select("id, canonical_name").in("id", scope),
    supabase.from("offer").select("business_id, entity_text, pricing").in("business_id", scope).limit(8000),
  ]);
  const nameById = new Map<string, string>();
  for (const b of biz ?? []) nameById.set((b as any).id, (b as any).canonical_name ?? "Unknown");

  const pricedByBiz = new Map<string, number>();
  const byProc = new Map<string, { label: string; prices: AnchorPrice[] }>();
  const seen = new Set<string>(); // dedup business|procedure|amount
  for (const o of offers ?? []) {
    const amount = Number((o as any).pricing?.amount);
    if (!Number.isFinite(amount) || amount <= 0) continue;
    const bid = (o as any).business_id as string;
    pricedByBiz.set(bid, (pricedByBiz.get(bid) ?? 0) + 1);
    const m = matchProcedure(String((o as any).entity_text ?? ""));
    if (!m) continue;
    const dk = `${bid}|${m.key}|${Math.round(amount)}`;
    if (seen.has(dk)) continue;
    seen.add(dk);
    const name = nameById.get(bid) ?? "Unknown";
    const g = byProc.get(m.key) ?? { label: m.label, prices: [] };
    g.prices.push({ business: name, isYou: bid === ids.targetId, amount, type: clinicType(name) });
    byProc.set(m.key, g);
  }

  const anchors: ProcedureAnchor[] = [...byProc.entries()]
    .map(([key, g]) => {
      const amts = g.prices.map((p) => p.amount);
      return { key, label: g.label, low: Math.min(...amts), high: Math.max(...amts), median: Math.round(median(amts)), prices: g.prices.sort((a, b) => a.amount - b.amount) };
    })
    .sort((a, b) => b.prices.length - a.prices.length);

  const transparency: TransparencyRow[] = (biz ?? [])
    .map((b) => {
      const bid = (b as any).id as string;
      const name = (b as any).canonical_name ?? "Unknown";
      const priced = pricedByBiz.get(bid) ?? 0;
      return { business: name, isYou: bid === ids.targetId, publishes: priced >= 1, pricedItems: priced, type: clinicType(name) };
    })
    .sort((a, b) => Number(b.publishes) - Number(a.publishes) || b.pricedItems - a.pricedItems);

  const publishedCount = transparency.filter((t) => !t.isYou && t.publishes).length;
  const opaqueCount = transparency.filter((t) => !t.isYou && !t.publishes).length;
  const youPublish = transparency.find((t) => t.isYou)?.publishes ?? false;
  const total = publishedCount + opaqueCount;

  let summary = "";
  if (total) {
    summary = `${publishedCount} of ${total} competitors publish real prices${opaqueCount ? `; ${opaqueCount} keep pricing off their site` : ""}. `;
    summary += youPublish ? "You publish too — that transparency is a trust edge worth promoting." : "You publish none — transparent pricing is a wide-open way to stand out.";
  }

  const empty = !anchors.length && !total;
  return { at, anchors, transparency, publishedCount, opaqueCount, youPublish, summary, ...(empty ? { empty: true } : {}) };
}
