import { createClient, type RlsClient } from "@/lib/supabase/server";
import { workspaceBusinessIds, type WorkspaceRow } from "@/lib/workspace";

/**
 * Insurance-acceptance comparison (dental). "Does this dentist take my insurance?"
 * is often a patient's #1 filter — so which plans each practice accepts is a real,
 * actionable competitive signal. We already extract it: the dental website module
 * emits an "Insurance accepted" entity with the payers in `conditions`. This reads
 * those across the target + competitors, canonicalizes payer names, and surfaces
 * WHO takes WHAT — including plans competitors accept that you don't advertise (a
 * gap to close) and plans only you take (a differentiator).
 *
 * Deterministic — no LLM, no new scraping (pure read over the offer table).
 * Dental-only; cached on goals.insurance. (Zocdoc, via Bright Data, would later
 * complete this for practices that don't publish insurance on their own site.)
 */

// Canonicalize the ~major dental payers so "Delta", "Delta Dental PPO", "BCBS",
// "Blue Cross" collapse to one name. Order matters (specific before generic).
const PAYER_ALIASES: [RegExp, string][] = [
  [/united\s*concordia/i, "United Concordia"],
  [/delta\s*dental|(^|\W)delta(\W|$)/i, "Delta Dental"],
  [/blue\s*cross|blue\s*shield|bcbs|anthem/i, "Blue Cross Blue Shield"],
  [/cigna/i, "Cigna"],
  [/aetna/i, "Aetna"],
  [/met\s*life/i, "MetLife"],
  [/guardian/i, "Guardian"],
  [/united\s*health|unitedhealthcare|\buhc\b|(^|\W)united(\W|$)/i, "UnitedHealthcare"],
  [/humana/i, "Humana"],
  [/ameritas/i, "Ameritas"],
  [/principal/i, "Principal"],
  [/careington/i, "Careington"],
  [/dentemax/i, "DenteMax"],
  [/medicaid|medi-?cal/i, "Medicaid"],
  [/medicare/i, "Medicare"],
  [/tricare/i, "Tricare"],
  [/sun\s*life/i, "Sun Life"],
  [/renaissance/i, "Renaissance"],
  [/\bgeha\b/i, "GEHA"],
  [/kaiser/i, "Kaiser Permanente"],
];
// generic phrases that are NOT a specific payer
const NOISE = /^(ppo|hmo|dhmo|in-?network|out-?of-?network|most (major )?insurance(s)?|dental insurance|we accept|accepted|please (verify|call)|verify( your)? coverage|insurance accepted|and more|others?|major (dental )?plans?|financing|carecredit|cash|self-?pay)$/i;

function canonPayer(raw: string): string | null {
  const t = String(raw ?? "").replace(/\s+/g, " ").trim().replace(/[.;:]+$/, "");
  if (t.length < 2 || NOISE.test(t)) return null;
  for (const [re, name] of PAYER_ALIASES) if (re.test(t)) return name;
  // an unknown but plausible payer name (letters, short, not noise)
  if (/^[a-z0-9 &'./-]{3,40}$/i.test(t) && /[a-z]/i.test(t) && !NOISE.test(t)) {
    return t.replace(/\b(ppo|hmo|dental|insurance|plan)\b/gi, "").replace(/\s+/g, " ").trim() || null;
  }
  return null;
}

/** Split a free-text insurance string ("Delta Dental, Cigna and MetLife") into payers. */
function payersFrom(parts: string[]): string[] {
  const out = new Set<string>();
  for (const p of parts) {
    for (const chunk of String(p ?? "").split(/[,;/|]|\band\b|·|•/i)) {
      const c = canonPayer(chunk);
      if (c) out.add(c);
    }
  }
  return [...out];
}

export interface BizInsurance { business: string; isYou: boolean; payers: string[] }
export interface InsuranceMarketRow { payer: string; count: number; youAccept: boolean; acceptedBy: string[] }
export interface InsuranceCompare {
  at: string;
  businesses: BizInsurance[];      // accepted payers per practice
  market: InsuranceMarketRow[];    // per payer: how many practices, incl. you
  youMissing: string[];            // payers competitors accept that you don't
  youUnique: string[];             // payers only you accept (a differentiator)
  youPayerCount: number;
  summary: string;
  empty?: boolean;
}

const emptyReport = (at: string): InsuranceCompare => ({ at, businesses: [], market: [], youMissing: [], youUnique: [], youPayerCount: 0, summary: "", empty: true });

export async function buildInsuranceCompare(ws: WorkspaceRow, db?: RlsClient): Promise<InsuranceCompare> {
  const at = new Date().toISOString();
  if (ws.vertical !== "dental") return emptyReport(at);
  const supabase = db ?? (await createClient());
  const ids = await workspaceBusinessIds(ws, supabase);
  const scope = ids.all;
  if (!scope.length) return emptyReport(at);

  const [{ data: biz }, { data: offers }, { data: dirItems }] = await Promise.all([
    supabase.from("business").select("id, canonical_name").in("id", scope),
    // website-sourced insurance (the dental module writes it as an "Insurance accepted" offer)
    supabase.from("offer").select("business_id, entity_text, conditions").in("business_id", scope).ilike("entity_text", "%insurance%").limit(2000),
    // directory-sourced insurance (Zocdoc via Bright Data emits an "Insurance accepted (Zocdoc)" review/profile item)
    supabase.from("content_item").select("business_id, text").in("business_id", scope).in("platform", ["zocdoc", "healthgrades"]).ilike("text", "%insurance accepted%").limit(2000),
  ]);
  const nameById = new Map<string, string>();
  for (const b of biz ?? []) nameById.set((b as any).id, (b as any).canonical_name ?? "Unknown");

  // gather payers per business — from website offers (entity_text + conditions) AND
  // directory content items (Zocdoc/Healthgrades insurance text), merged.
  const payersByBiz = new Map<string, Set<string>>();
  const add = (bid: string, found: string[]) => {
    if (!found.length) return;
    const set = payersByBiz.get(bid) ?? new Set<string>();
    for (const p of found) set.add(p);
    payersByBiz.set(bid, set);
  };
  for (const o of offers ?? []) {
    const conds = Array.isArray((o as any).conditions) ? (o as any).conditions as string[] : [];
    add((o as any).business_id as string, payersFrom([String((o as any).entity_text ?? ""), ...conds]));
  }
  for (const c of dirItems ?? []) {
    add((c as any).business_id as string, payersFrom([String((c as any).text ?? "")]));
  }

  const businesses: BizInsurance[] = [...payersByBiz.entries()]
    .map(([bid, set]) => ({ business: nameById.get(bid) ?? "Unknown", isYou: bid === ids.targetId, payers: [...set].sort() }))
    .sort((a, b) => Number(b.isYou) - Number(a.isYou) || b.payers.length - a.payers.length);

  const you = businesses.find((b) => b.isYou);
  const youPayers = new Set(you?.payers ?? []);

  // per-payer market view
  const marketMap = new Map<string, { count: number; you: boolean; by: string[] }>();
  for (const b of businesses) for (const p of b.payers) {
    const m = marketMap.get(p) ?? { count: 0, you: false, by: [] };
    m.count++; if (b.isYou) m.you = true; if (!b.isYou) m.by.push(b.business);
    marketMap.set(p, m);
  }
  const market: InsuranceMarketRow[] = [...marketMap.entries()]
    .map(([payer, m]) => ({ payer, count: m.count, youAccept: m.you, acceptedBy: m.by }))
    .sort((a, b) => b.count - a.count || a.payer.localeCompare(b.payer));

  // gaps + differentiators (only meaningful when we actually know YOUR payers)
  const competitorPayers = new Map<string, number>();
  for (const b of businesses) if (!b.isYou) for (const p of b.payers) competitorPayers.set(p, (competitorPayers.get(p) ?? 0) + 1);
  const youMissing = you ? [...competitorPayers.entries()].filter(([p]) => !youPayers.has(p)).sort((a, b) => b[1] - a[1]).map(([p]) => p) : [];
  const youUnique = you ? [...youPayers].filter((p) => !competitorPayers.has(p)).sort() : [];

  let summary = "";
  const rivalCount = businesses.filter((b) => !b.isYou).length;
  if (you && you.payers.length) {
    summary = `You list ${you.payers.length} insurance plan${you.payers.length === 1 ? "" : "s"}. `;
    if (youMissing.length) summary += `${youMissing.slice(0, 3).join(", ")}${youMissing.length > 3 ? " +more" : ""} — accepted by competitors but not on your site${youMissing.length ? " (add if you're in-network)" : ""}. `;
    if (youUnique.length) summary += `You're the only one listing ${youUnique.slice(0, 2).join(" & ")} — a differentiator to promote.`;
  } else if (market.length) {
    summary = `Competitors list ${market.length} plans across your market (${market.slice(0, 3).map((m) => m.payer).join(", ")}…). Publish which you accept — it's a top patient filter.`;
  }

  const empty = !businesses.length;
  return { at, businesses, market, youMissing, youUnique, youPayerCount: youPayers.size, summary, ...(empty ? { empty: true } : {}) };
}
