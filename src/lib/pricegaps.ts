import { createClient, createServiceClient } from "@/lib/supabase/server";
import type { WorkspaceRow } from "@/lib/workspace";
import { workspaceBusinessIds } from "@/lib/workspace";
import { getLlm, isLlmConfigured } from "@/lib/extraction/llm";
import type { FlyerDeal } from "@/lib/flyers";

/**
 * "You vs them" price-gap intelligence. Rather than dumping every string match,
 * an LLM matches OUR advertised prices to RIVALS' — across synonyms/other
 * languages (Beetroot = Chukandar), size/brand variants, and UNITS (/lb vs /ea vs
 * "N for $X", normalized) — and surfaces ONLY the findings that matter: where
 * we're undercut, where we win, or a staple rivals price low that we don't
 * advertise. Cached on workspace.goals.priceGaps.
 */

export type GapVerdict = "undercut" | "you_cheaper" | "you_absent";
export interface PriceGap { item: string; verdict: GapVerdict; yourPrice?: string; rivalPrice: string; rival: string; note: string; action: string }
export interface PriceGapReport { summary: string; gaps: PriceGap[]; at: string; empty?: boolean; failed?: boolean }

const clean = (s?: string) => String(s ?? "").replace(/\s+/g, " ").trim();
const emptyReport = (at: string, failed = false): PriceGapReport => ({ summary: "", gaps: [], at, empty: true, ...(failed ? { failed: true } : {}) });

const SCHEMA = {
  type: "object", additionalProperties: false,
  properties: {
    summary: { type: "string", description: "ONE sentence: where this business stands on price vs its rivals right now." },
    gaps: {
      type: "array", maxItems: 6,
      description: "The price findings that MATTER, most important first. Skip weak matches and trivial differences.",
      items: {
        type: "object", additionalProperties: false,
        properties: {
          item: { type: "string", description: "the product, in plain words" },
          verdict: { type: "string", enum: ["undercut", "you_cheaper", "you_absent"], description: "undercut = a rival is cheaper than us; you_cheaper = we're cheaper; you_absent = rivals price this staple but we don't advertise a price" },
          yourPrice: { type: "string", description: "our advertised price as printed, or '' if we don't advertise one" },
          rivalPrice: { type: "string", description: "the rival's price as printed" },
          rival: { type: "string", description: "which rival" },
          note: { type: "string", description: "the comparison in plain words, units reconciled (e.g. 'They're $0.50/lb cheaper on onions')" },
          action: { type: "string", description: "one specific move for the owner (e.g. 'Match at $0.99/lb and post it this weekend')" },
        },
        required: ["item", "verdict", "rivalPrice", "rival", "note", "action"],
      },
    },
  },
  required: ["summary", "gaps"],
};

const SYSTEM =
  "You are a sharp pricing analyst for a local business in ANY industry. You compare OUR advertised prices against RIVALS'. Match items ONLY when they're genuinely the SAME offering — a product, dish, service, treatment or package. Use the business's vertical for context and account for synonyms, other languages, and equivalent names — e.g. grocery: Beetroot = Chukandar = Beets; restaurant: 'Chicken Biryani' portions; salon: 'Gel manicure' ≈ 'Gel nails'; barber: \"Men's haircut\" ≈ \"Men's cut\"; med-spa: 'Botox per unit', 'HydraFacial'. Reconcile UNITS before judging (/lb, /ea, per session, per person, per unit, 'from $X', 'N for $X'). Surface ONLY findings that matter to an owner: we're clearly pricier than a rival on a common offering (undercut), we're clearly cheaper (a win), or rivals price a popular offering low that we don't advertise (you_absent). Ignore weak matches, trivial differences, and niche one-offs. Be concise and specific; never invent a price. If there's nothing meaningful to say, return an empty gaps array.";

function parseArr(v: unknown): any[] { return Array.isArray(v) ? v : []; }

export async function analyzePriceGaps(ws: WorkspaceRow): Promise<PriceGapReport> {
  const at = new Date().toISOString();
  const supabase = await createClient();

  const { data: wRow } = await supabase.from("workspace").select("goals").eq("id", ws.id).maybeSingle();
  const goals = (wRow?.goals as Record<string, any>) ?? {};
  const theirs: FlyerDeal[] = (goals.flyerDeals?.deals ?? []).filter((d: FlyerDeal) => d.price);
  const ours: { item: string; price: string }[] = (goals.myFlyerDeals?.deals ?? [])
    .filter((d: FlyerDeal) => d.price).map((d: FlyerDeal) => ({ item: clean(d.item), price: clean(d.price) }));

  // also fold in the owner's priced catalog items (offer table), if any
  const ids = await workspaceBusinessIds(ws, supabase);
  if (ids.targetId) {
    const { data: off } = await supabase.from("offer").select("entity_text, pricing").eq("business_id", ids.targetId).limit(200);
    for (const o of off ?? []) {
      const amt = Number((o.pricing as any)?.amount);
      if (Number.isFinite(amt) && amt > 0) ours.push({ item: clean(o.entity_text as string), price: `$${amt}` });
    }
  }

  if (theirs.length < 3) return emptyReport(at);            // nothing to compare against
  if (!isLlmConfigured()) return emptyReport(at);

  const theirList = theirs.slice(0, 60).map((d) => `- ${d.rival}: ${clean(d.item)} @ ${clean(d.price)}`).join("\n");
  const ourList = ours.length ? ours.slice(0, 60).map((d) => `- ${d.item} @ ${d.price}`).join("\n") : "(we don't advertise any prices right now)";
  const prompt = `Business: "${ws.name}" (vertical: ${ws.vertical}).\n\nOUR ADVERTISED PRICES:\n${ourList}\n\nRIVALS' ADVERTISED PRICES:\n${theirList}\n\nFind the price gaps that matter and fill the gaps array.`;

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const { data } = await getLlm().callStructured<{ summary: string; gaps: unknown }>({ system: SYSTEM, text: prompt, schema: SCHEMA, tier: "extract", maxTokens: 1600 });
      const gaps: PriceGap[] = parseArr(data.gaps).map((g) => ({
        item: clean(g.item), verdict: (["undercut", "you_cheaper", "you_absent"].includes(g.verdict) ? g.verdict : "undercut") as GapVerdict,
        yourPrice: clean(g.yourPrice) || undefined, rivalPrice: clean(g.rivalPrice), rival: clean(g.rival), note: clean(g.note), action: clean(g.action),
      })).filter((g) => g.item && g.rivalPrice && g.note).slice(0, 6);
      return { summary: clean(data.summary), gaps, at, ...(gaps.length ? {} : { empty: true }) };
    } catch { if (attempt === 0) await new Promise((r) => setTimeout(r, 3000)); }
  }
  return emptyReport(at, true);
}

/** Cached price-gap report — regenerated when stale OR when a newer flyer read landed. */
export async function getOrMakePriceGaps(ws: WorkspaceRow, maxAgeHours = 8): Promise<PriceGapReport> {
  const supabase = await createClient();
  const { data } = await supabase.from("workspace").select("goals").eq("id", ws.id).maybeSingle();
  const goals = (data?.goals as Record<string, any>) ?? {};
  const cached = goals.priceGaps as PriceGapReport | undefined;
  const flyerAt = goals.flyerDeals?.at as string | undefined;
  const fresh = cached?.at && Date.now() - new Date(cached.at).getTime() < maxAgeHours * 3600_000 && !cached.failed
    && (!flyerAt || new Date(flyerAt).getTime() <= new Date(cached.at).getTime());
  if (fresh && cached) return cached;

  const report = await analyzePriceGaps(ws);
  const svc = createServiceClient();
  const { data: cur } = await svc.from("workspace").select("goals").eq("id", ws.id).maybeSingle();
  await svc.from("workspace").update({ goals: { ...((cur?.goals as object) ?? {}), priceGaps: report } }).eq("id", ws.id);
  return report;
}
