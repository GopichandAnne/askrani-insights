import { activeWorkspace, workspaceBusinessIds } from "@/lib/workspace";
import { createClient } from "@/lib/supabase/server";
import { getOrMakeDeals, getOrMakeMyDeals, type DealItem } from "@/lib/deals";
import { ScreenNotReady } from "@/components/ScreenNotReady";
import { TrustChip, ProvenanceBadge } from "@/components/TrustChip";
import { MarketTabs } from "@/components/MarketTabs";

export const dynamic = "force-dynamic";

const SOURCE_LABEL: Record<string, string> = {
  instagram: "Instagram", facebook: "Facebook", tiktok: "TikTok", google: "Google", website: "their site",
};
function sourceLabel(s?: string) { return (s && SOURCE_LABEL[s]) || "online"; }

export default async function OffersPage() {
  const state = await activeWorkspace();
  if (state.status !== "ok") return <ScreenNotReady state={state} title="Offers & pricing" />;
  const ws = state.workspace;

  const ids = await workspaceBusinessIds(ws);
  const supabase = await createClient();

  // The headline value: what deals rivals + you are running right now.
  const [rivalDeals, myDeals] = await Promise.all([getOrMakeDeals(ws), getOrMakeMyDeals(ws)]);
  const flyerDeals = ((ws.goals as { flyerDeals?: { deals?: any[] } } | undefined)?.flyerDeals?.deals ?? []) as any[];

  // group rivals' deals by competitor
  const dealsByRival = new Map<string, DealItem[]>();
  for (const d of rivalDeals.deals) { const a = dealsByRival.get(d.rival) ?? []; a.push(d); dealsByRival.set(d.rival, a); }
  const flyersByRival = new Map<string, any[]>();
  for (const d of flyerDeals) { const a = flyersByRival.get(d.rival) ?? []; a.push(d); flyersByRival.set(d.rival, a); }

  // ── price catalog (secondary): from the offer table ──
  const { data: offers } = await supabase
    .from("offer")
    .select("id,entity_text,offer_type,pricing,confidence,provenance,observed_at,business_id,business:business_id(canonical_name)")
    .in("business_id", ids.all.length ? ids.all : ["00000000-0000-0000-0000-000000000000"])
    .order("observed_at", { ascending: false })
    .limit(400);
  const byBiz = new Map<string, { name: string; isTarget: boolean; rows: any[] }>();
  for (const o of offers ?? []) {
    const key = o.business_id as string;
    if (!byBiz.has(key)) byBiz.set(key, { name: (o.business as any)?.canonical_name ?? "Unknown", isTarget: key === ids.targetId, rows: [] });
    const bucket = byBiz.get(key)!;
    if (!bucket.rows.some((r) => r.entity_text.toLowerCase() === (o.entity_text as string).toLowerCase())) bucket.rows.push(o);
  }
  const groups = [...byBiz.values()].sort((a, b) => Number(b.isTarget) - Number(a.isTarget));
  const priceRows = groups
    .map((g) => {
      const prices = g.rows.map((r) => Number((r.pricing as any)?.amount)).filter((n) => Number.isFinite(n) && n > 0);
      const avg = prices.length ? prices.reduce((a, b) => a + b, 0) / prices.length : null;
      return { name: g.name, isTarget: g.isTarget, count: prices.length, avg, min: prices.length ? Math.min(...prices) : null, max: prices.length ? Math.max(...prices) : null };
    })
    .filter((r) => r.count > 0)
    .sort((a, b) => Number(b.isTarget) - Number(a.isTarget) || (a.avg ?? 0) - (b.avg ?? 0));
  const totalPriced = priceRows.reduce((a, r) => a + r.count, 0);
  const usd = (n: number | null) => (n == null ? "—" : `$${n.toFixed(2)}`);

  const hasRivalDeals = dealsByRival.size > 0 || flyersByRival.size > 0;

  return (
    <div className="animate-fade-in space-y-5">
      <div>
        <p className="text-sm font-medium text-brand-deep">Ask Rani Insights</p>
        <h1 className="mt-1 font-display text-3xl font-extrabold tracking-tight">Offers &amp; deals</h1>
        <p className="mt-1 max-w-2xl text-sm text-ink-soft">
          What sales and promos your competitors are running right now — pulled from their social, Google and websites — next to yours.
        </p>
      </div>

      <MarketTabs />

      {/* ── HEADLINE: rivals' current deals, grouped by competitor ── */}
      <section className="card">
        <div className="mb-1 flex items-center justify-between">
          <h2 className="flex items-center gap-2 font-semibold">
            <span className="grid h-7 w-7 place-items-center rounded-lg bg-brand-gradient text-white shadow-brand">🏷️</span>
            What your rivals are offering now
          </h2>
          {hasRivalDeals && <span className="text-xs text-ink-faint">{rivalDeals.deals.length + flyerDeals.length} live offers · {dealsByRival.size + flyersByRival.size} rivals</span>}
        </div>
        {rivalDeals.summary && <p className="mb-3 max-w-3xl text-sm text-ink-soft">{rivalDeals.summary}</p>}

        {!hasRivalDeals ? (
          <p className="rounded-2xl border border-dashed border-line p-4 text-sm text-ink-soft">
            <span className="font-semibold text-ink">No competitor offers detected yet.</span> Rani reads rivals&apos; Instagram, Facebook,
            Google posts and websites for sales &amp; promos. Make sure your competitors&apos; pages are connected under
            <span className="font-medium text-brand-deep"> Channels</span>, then re-collect — offers show up here as they post them.
          </p>
        ) : (
          <div className="grid gap-4 md:grid-cols-2">
            {[...dealsByRival.entries()].map(([rival, items], gi) => (
              <div key={`d-${gi}`} className="rounded-2xl bg-white/55 p-3.5">
                <p className="mb-1.5 text-sm font-semibold text-brand-deep">{rival}</p>
                <ul className="divide-y divide-line/50">
                  {items.slice(0, 8).map((d, i) => (
                    <li key={i} className="flex items-start justify-between gap-2 py-1.5 text-sm">
                      <span className="min-w-0 text-ink">
                        {d.deal}
                        {d.when && <span className="text-ink-faint"> · {d.when}</span>}
                        <span className="ml-1 text-xs text-ink-faint">on {sourceLabel(d.source)}</span>
                      </span>
                      {d.url && <a href={d.url} target="_blank" rel="noreferrer" className="shrink-0 text-xs font-medium text-brand hover:underline">see ↗</a>}
                    </li>
                  ))}
                </ul>
              </div>
            ))}
            {/* flyer-image deals (grocery weekly ads), when present */}
            {[...flyersByRival.entries()].map(([rival, items], gi) => (
              <div key={`f-${gi}`} className="rounded-2xl bg-white/55 p-3.5">
                <p className="mb-1.5 flex items-center gap-1.5 text-sm font-semibold text-brand-deep">{rival} <span className="chip bg-coral/15 text-coral-dark">🧾 flyer</span></p>
                <ul className="divide-y divide-line/50">
                  {items.slice(0, 8).map((d, i) => (
                    <li key={i} className="flex items-center justify-between gap-2 py-1.5 text-sm">
                      <span className="min-w-0 truncate text-ink">{d.item}{d.terms ? <span className="text-ink-faint"> · {d.terms}</span> : null}</span>
                      {d.price && <span className="shrink-0 font-semibold text-coral-dark">{d.price}</span>}
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        )}

        {/* Rani's moves */}
        {rivalDeals.moves.length > 0 && (
          <div className="mt-4 rounded-2xl bg-brand-soft/50 p-3">
            <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-brand-deep">Your move</p>
            <ul className="space-y-1 text-sm text-brand-deep">{rivalDeals.moves.map((m, i) => <li key={i}>✦ {m}</li>)}</ul>
          </div>
        )}
      </section>

      {/* ── YOURS: what the owner is currently promoting ── */}
      <section className="card">
        <h2 className="mb-1 flex items-center gap-2 font-semibold">
          <span className="grid h-7 w-7 place-items-center rounded-lg bg-brand-soft text-brand">🟢</span>
          Your current offers
        </h2>
        {myDeals.deals.length === 0 ? (
          <p className="rounded-2xl border border-dashed border-line p-4 text-sm text-ink-soft">
            Rani didn&apos;t find an active offer you&apos;re promoting. {hasRivalDeals ? "Your rivals are running deals above — consider posting one to match." : "Post a sale on your social/Google and Rani will track it here."}
          </p>
        ) : (
          <ul className="divide-y divide-line/50">
            {myDeals.deals.slice(0, 12).map((d, i) => (
              <li key={i} className="flex items-start justify-between gap-2 py-1.5 text-sm">
                <span className="min-w-0 text-ink">{d.deal}{d.when && <span className="text-ink-faint"> · {d.when}</span>}<span className="ml-1 text-xs text-ink-faint">on {sourceLabel(d.source)}</span></span>
                {d.url && <a href={d.url} target="_blank" rel="noreferrer" className="shrink-0 text-xs font-medium text-brand hover:underline">see ↗</a>}
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* ── SECONDARY: price positioning from the priced-offer catalog ── */}
      {totalPriced > 0 && (
        <section className="card">
          <div className="flex items-center justify-between">
            <h2 className="flex items-center gap-2 font-semibold"><span className="grid h-7 w-7 place-items-center rounded-lg bg-brand-soft text-brand">💸</span>Price positioning</h2>
            <span className="text-xs text-ink-faint">{totalPriced} priced items</span>
          </div>
          <table className="mt-3 w-full text-sm">
            <thead><tr className="border-b border-line text-left text-xs text-ink-faint"><th className="py-1.5 font-medium">Business</th><th className="py-1.5 text-right font-medium">Avg</th><th className="py-1.5 text-right font-medium">Range</th><th className="py-1.5 text-right font-medium">Items</th></tr></thead>
            <tbody>
              {priceRows.map((r) => (
                <tr key={r.name} className={`border-b border-line/50 ${r.isTarget ? "bg-brand-soft/30" : ""}`}>
                  <td className="py-1.5">{r.isTarget && <span className="mr-1 text-xs font-semibold text-brand">You ·</span>}{r.name}</td>
                  <td className="py-1.5 text-right font-semibold tabular-nums text-brand-deep">{usd(r.avg)}</td>
                  <td className="py-1.5 text-right tabular-nums text-ink-faint">{usd(r.min)}–{usd(r.max)}</td>
                  <td className="py-1.5 text-right tabular-nums text-ink-soft">{r.count}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}
    </div>
  );
}
