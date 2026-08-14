/**
 * The Rani operations slice — the INSIDE half of the "one data umbrella". Insights
 * watches the market (outside); Rani serves customers (inside: real orders, promos,
 * loyalty reach, and the promote-and-earn / co-marketing engine). To reason like a
 * true business assistant the advisor needs both — so here we pull a READ-ONLY,
 * AGGREGATE slice of the business's own Rani data (never raw customer PII).
 *
 * Rani and Insights are separate Supabase projects, so this is a governed CONTRACT,
 * not a schema reach-in: Rani decides what to expose. Two sources, env-gated:
 *   • push/seed — Rani writes a slice onto goals.raniOps (works today, zero coupling)
 *   • pull — GET RANI_OPS_URL?store=<slug> with RANI_OPS_SECRET (when wired)
 * Graceful no-op when neither is available. Aggregates only — the privacy boundary
 * between first-party customer data and public market data stays intact.
 */

export interface RaniOps {
  topItems?: { name: string; orders?: number }[]; // best sellers (units/orders)
  activePromos?: string[];                          // promos you're running in Rani
  coMarketing?: { advocates?: number; creditsIssued?: string; shares?: number; topAdvocate?: string }; // promote-and-earn
  loyaltyContacts?: number;                         // reachable customers (for a blast)
  requestThemes?: string[];                         // what customers keep asking Rani for
  at?: string;
}

export function raniConfigured(): boolean {
  return !!(process.env.RANI_OPS_URL && process.env.RANI_OPS_SECRET);
}

const slugify = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
const clean = (v: unknown) => String(v ?? "").replace(/\s+/g, " ").trim();

function formatOps(o: RaniOps): string {
  const lines: string[] = [];
  const items = (o.topItems ?? []).filter((i) => i?.name).slice(0, 8).map((i) => `${clean(i.name)}${i.orders ? ` (${i.orders} orders)` : ""}`);
  if (items.length) lines.push(`Top sellers, best first: ${items.join(", ")}`);
  const promos = (o.activePromos ?? []).map(clean).filter(Boolean).slice(0, 6);
  if (promos.length) lines.push(`Promos you're currently running: ${promos.join("; ")}`);
  const cm = o.coMarketing;
  if (cm && (cm.advocates || cm.shares || cm.creditsIssued)) {
    const bits = [];
    if (cm.advocates) bits.push(`${cm.advocates} customers actively promoting you`);
    if (cm.shares) bits.push(`${cm.shares} shares/posts`);
    if (cm.creditsIssued) bits.push(`${clean(cm.creditsIssued)} in store credit issued`);
    if (cm.topAdvocate) bits.push(`top advocate: ${clean(cm.topAdvocate)}`);
    lines.push(`Promote-and-earn (your customers marketing you for store credit): ${bits.join(", ")}`);
  }
  if (o.loyaltyContacts) lines.push(`Reachable customers on your list (can message directly): ${o.loyaltyContacts}`);
  const themes = (o.requestThemes ?? []).map(clean).filter(Boolean).slice(0, 6);
  if (themes.length) lines.push(`What your own customers keep asking for: ${themes.join(", ")}`);
  return lines.join("\n");
}

/** Fetch the read-only Rani operations slice for this workspace's business.
 *  Prefers a slice Rani has pushed onto goals.raniOps; else pulls the governed
 *  aggregate endpoint if configured; else empty. */
export async function fetchRaniOps(ws: { name: string }, goals: Record<string, any>): Promise<{ text: string; ops: RaniOps | null }> {
  let ops: RaniOps | null = (goals?.raniOps && typeof goals.raniOps === "object") ? (goals.raniOps as RaniOps) : null;

  if (!ops && raniConfigured()) {
    try {
      const slug = clean(goals?.raniStore) || slugify(ws.name);
      const r = await fetch(`${process.env.RANI_OPS_URL}?store=${encodeURIComponent(slug)}`, {
        headers: { authorization: `Bearer ${process.env.RANI_OPS_SECRET}` },
        cache: "no-store",
      });
      if (r.ok) ops = (await r.json()) as RaniOps;
    } catch { ops = null; }
  }

  if (!ops) return { text: "", ops: null };
  const text = formatOps(ops);
  return { text, ops: text ? ops : null };
}
