import { activeWorkspace, workspaceBusinessIds } from "@/lib/workspace";
import { createClient } from "@/lib/supabase/server";
import { getOrMakeDeals, getOrMakeMyDeals, type DealItem } from "@/lib/deals";
import { getOrMakePriceGaps, type GapVerdict } from "@/lib/pricegaps";
import type { FlyerDeal } from "@/lib/flyers";
import { flyersConfigured } from "@/lib/flyers";
import { quoteFlyerRead, FLYER_READ_COMPETITOR_CAP } from "@/lib/credits";
import { FlyerReadButton } from "@/components/FlyerReadButton";
import { ScreenNotReady } from "@/components/ScreenNotReady";
import { MarketTabs } from "@/components/MarketTabs";

export const dynamic = "force-dynamic";

const SOURCE_LABEL: Record<string, string> = { instagram: "Instagram", facebook: "Facebook", tiktok: "TikTok", google: "Google", website: "website" };
const sourceLabel = (s?: string) => (s && SOURCE_LABEL[s]) || "online";
const parseUsd = (s?: string) => { const m = String(s ?? "").match(/\$\s*(\d+(?:\.\d+)?)/) ?? String(s ?? "").match(/(\d+(?:\.\d+)?)/); return m ? Number(m[1]) : null; };

interface RivalBundle { rival: string; promos: DealItem[]; priced: FlyerDeal[]; sources: Set<string> }

export default async function OffersPage() {
  const state = await activeWorkspace();
  if (state.status !== "ok") return <ScreenNotReady state={state} title="Offers & deals" />;
  const ws = state.workspace;

  const ids = await workspaceBusinessIds(ws);
  const supabase = await createClient();

  const [rivalDeals, myDeals, priceGaps] = await Promise.all([getOrMakeDeals(ws), getOrMakeMyDeals(ws), getOrMakePriceGaps(ws)]);
  const flyerDeals = ((ws.goals as { flyerDeals?: { deals?: FlyerDeal[] } } | undefined)?.flyerDeals?.deals ?? []) as FlyerDeal[];

  // merge everything into ONE bundle per rival (promos + priced flyer items)
  const map = new Map<string, RivalBundle>();
  const bundle = (r: string) => { if (!map.has(r)) map.set(r, { rival: r, promos: [], priced: [], sources: new Set() }); return map.get(r)!; };
  for (const d of rivalDeals.deals) { const b = bundle(d.rival); b.promos.push(d); if (d.source) b.sources.add(d.source); }
  for (const d of flyerDeals) { const b = bundle(d.rival); b.priced.push(d); if (d.source) b.sources.add(d.source); }
  const rivals = [...map.values()].sort((a, b) => (b.priced.length + b.promos.length) - (a.priced.length + a.promos.length));

  // "lowest prices rivals are advertising" — the aggressive prices to match
  const seen = new Set<string>();
  const lowest = flyerDeals
    .map((d) => ({ d, n: parseUsd(d.price) }))
    .filter((x) => x.n != null)
    .sort((a, b) => (a.n! - b.n!))
    .filter((x) => { const k = `${x.d.rival}|${x.d.item}`.toLowerCase(); if (seen.has(k)) return false; seen.add(k); return true; })
    .slice(0, 10);

  const itemsOnSale = flyerDeals.length;
  const hasAnything = rivals.length > 0;
  const canFlyer = flyersConfigured() && ids.competitorIds.length > 0;
  const flyerCost = quoteFlyerRead(Math.min(ids.competitorIds.length, FLYER_READ_COMPETITOR_CAP));

  // ── price catalog (secondary) ──
  const { data: offers } = await supabase
    .from("offer").select("id,entity_text,pricing,business_id,business:business_id(canonical_name)")
    .in("business_id", ids.all.length ? ids.all : ["00000000-0000-0000-0000-000000000000"])
    .order("observed_at", { ascending: false }).limit(400);
  const byBiz = new Map<string, { name: string; isTarget: boolean; prices: number[] }>();
  for (const o of offers ?? []) {
    const key = o.business_id as string;
    if (!byBiz.has(key)) byBiz.set(key, { name: (o.business as any)?.canonical_name ?? "Unknown", isTarget: key === ids.targetId, prices: [] });
    const amt = Number((o.pricing as any)?.amount);
    if (Number.isFinite(amt) && amt > 0) byBiz.get(key)!.prices.push(amt);
  }
  const priceRows = [...byBiz.values()].filter((g) => g.prices.length)
    .map((g) => ({ name: g.name, isTarget: g.isTarget, count: g.prices.length, avg: g.prices.reduce((a, b) => a + b, 0) / g.prices.length, min: Math.min(...g.prices), max: Math.max(...g.prices) }))
    .sort((a, b) => Number(b.isTarget) - Number(a.isTarget) || a.avg - b.avg);
  const usd = (n: number) => `$${n.toFixed(2)}`;

  return (
    <div className="animate-fade-in space-y-5">
      <div>
        <p className="text-sm font-medium text-brand-deep">Ask Rani Insights</p>
        <h1 className="mt-1 font-display text-3xl font-extrabold tracking-tight">Offers &amp; deals</h1>
        <p className="mt-1 max-w-2xl text-sm text-ink-soft">The sales and prices your competitors are running right now — read from their posts, Google and flyer images — so you can match or beat them.</p>
      </div>

      <MarketTabs />

      {/* at-a-glance + actions */}
      <section className="card">
        <div className="flex flex-wrap items-center gap-2">
          <span className="chip bg-brand-soft font-semibold text-brand-deep">{rivals.length} {rivals.length === 1 ? "rival" : "rivals"} with offers</span>
          {itemsOnSale > 0 && <span className="chip bg-coral/15 font-semibold text-coral-dark">{itemsOnSale} items on sale</span>}
          {lowest[0] && <span className="chip bg-surface-sunken text-ink-soft">lowest spotted: <b className="ml-1 text-coral-dark">{lowest[0].d.price}</b> {lowest[0].d.item}</span>}
        </div>
        {rivalDeals.summary && <p className="mt-3 max-w-3xl text-sm text-ink-soft">{rivalDeals.summary}</p>}
        {canFlyer && (
          <div className="mt-3 rounded-2xl border border-brand/20 bg-brand-soft/40 p-3">
            <p className="mb-1.5 text-sm font-medium text-brand-deep">🧾 Rivals print their sale prices inside <b>flyer &amp; menu images</b> on Instagram, Facebook and Google Maps — Rani reads the prices right off them.</p>
            <FlyerReadButton workspaceId={ws.id} cost={flyerCost} />
          </div>
        )}
        {rivalDeals.moves.length > 0 && (
          <div className="mt-3 rounded-2xl bg-brand-soft/50 p-3">
            <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-brand-deep">Your move</p>
            <ul className="space-y-1 text-sm text-brand-deep">{rivalDeals.moves.map((m, i) => <li key={i}>✦ {m}</li>)}</ul>
          </div>
        )}
        {!hasAnything && (
          <p className="mt-3 rounded-2xl border border-dashed border-line p-4 text-sm text-ink-soft">
            <span className="font-semibold text-ink">No competitor offers detected yet.</span> Connect your competitors&apos; Instagram/Facebook pages under <span className="font-medium text-brand-deep">Channels</span> and use <b>Read their sale flyers</b> above — their sales show up here as they post them.
          </p>
        )}
      </section>

      {/* lowest prices — the aggressive prices to match */}
      {lowest.length > 0 && (
        <section className="card">
          <h2 className="mb-1 flex items-center gap-2 font-semibold"><span className="grid h-7 w-7 place-items-center rounded-lg bg-coral/15 text-coral-dark">🔻</span>Lowest prices your rivals are advertising</h2>
          <p className="mb-3 text-xs text-ink-faint">The sharpest prices Rani found on their flyers — the ones to match or beat.</p>
          <div className="grid gap-1.5 sm:grid-cols-2">
            {lowest.map((x, i) => (
              <div key={i} className="flex items-center justify-between gap-2 rounded-xl bg-white/55 px-3 py-2 text-sm">
                <span className="min-w-0 truncate text-ink">{x.d.item}<span className="ml-1 text-xs text-ink-faint">· {x.d.rival}</span></span>
                <span className="shrink-0 font-bold text-coral-dark">{x.d.price}</span>
              </div>
            ))}
          </div>
        </section>
      )}

      {/* You vs them — intelligent price-gap findings (only what matters) */}
      {priceGaps.gaps.length > 0 && (() => {
        const STYLE: Record<GapVerdict, { badge: string; label: string; ring: string }> = {
          undercut: { badge: "bg-coral/15 text-coral-dark", label: "You're higher", ring: "border-coral/30" },
          you_cheaper: { badge: "bg-trust-direct/15 text-trust-direct", label: "You win", ring: "border-trust-direct/30" },
          you_absent: { badge: "bg-amber-400/20 text-amber-700", label: "You're silent", ring: "border-amber-400/40" },
        };
        return (
          <section className="card">
            <h2 className="mb-1 flex items-center gap-2 font-semibold"><span className="grid h-7 w-7 place-items-center rounded-lg bg-brand-gradient text-white shadow-brand">⚖️</span>You vs your rivals on price</h2>
            {priceGaps.summary && <p className="mb-3 max-w-3xl text-sm text-ink-soft">{priceGaps.summary}</p>}
            <div className="space-y-2">
              {priceGaps.gaps.map((g, i) => {
                const s = STYLE[g.verdict];
                return (
                  <div key={i} className={`rounded-2xl border ${s.ring} bg-white/55 p-3`}>
                    <div className="flex flex-wrap items-center gap-2">
                      <span className={`chip font-semibold ${s.badge}`}>{s.label}</span>
                      <span className="font-semibold text-ink">{g.item}</span>
                      <span className="text-sm text-ink-soft">
                        {g.yourPrice ? <>you <b>{g.yourPrice}</b> · </> : null}{g.rival} <b className="text-coral-dark">{g.rivalPrice}</b>
                      </span>
                    </div>
                    <p className="mt-1.5 text-sm text-ink-soft">{g.note}</p>
                    <p className="mt-1 text-sm font-semibold text-brand-deep">✦ {g.action}</p>
                  </div>
                );
              })}
            </div>
          </section>
        );
      })()}

      {/* one merged card per rival */}
      {rivals.length > 0 && (
        <div className="grid gap-4 lg:grid-cols-2">
          {rivals.map((r, gi) => {
            const link = r.priced.find((d) => d.postUrl || d.imageUrl)?.postUrl || r.priced.find((d) => d.imageUrl)?.imageUrl || r.promos.find((d) => d.url)?.url;
            return (
              <div key={gi} className="card">
                <div className="flex items-center justify-between gap-2">
                  <span className="font-semibold">{r.rival}</span>
                  <span className="flex flex-wrap gap-1">{[...r.sources].map((s) => <span key={s} className="chip bg-surface-sunken text-ink-faint">{sourceLabel(s)}</span>)}</span>
                </div>
                {r.promos.length > 0 && (
                  <div className="mt-2 flex flex-wrap gap-1.5">
                    {r.promos.slice(0, 4).map((d, i) => <span key={i} className="chip bg-coral/15 text-coral-dark">🏷️ {d.deal}{d.when ? ` · ${d.when}` : ""}</span>)}
                  </div>
                )}
                {r.priced.length > 0 && (
                  <ul className="mt-3 divide-y divide-line/50">
                    {r.priced.slice(0, 8).map((d, i) => (
                      <li key={i} className="flex items-center justify-between gap-2 py-1.5 text-sm">
                        <span className="min-w-0 truncate text-ink">{d.item}{d.terms ? <span className="text-ink-faint"> · {d.terms}</span> : null}</span>
                        {d.price && <span className="shrink-0 font-semibold text-coral-dark">{d.price}</span>}
                      </li>
                    ))}
                  </ul>
                )}
                <div className="mt-2 flex items-center justify-between text-xs">
                  <span className="text-ink-faint">{r.priced.length > 8 ? `+${r.priced.length - 8} more items` : `${r.priced.length + r.promos.length} offers`}</span>
                  {link && <a href={link} target="_blank" rel="noreferrer" className="font-medium text-brand hover:underline">see source ↗</a>}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* your offers */}
      <section className="card">
        <h2 className="mb-1 flex items-center gap-2 font-semibold"><span className="grid h-7 w-7 place-items-center rounded-lg bg-brand-soft text-brand">🟢</span>Your current offers</h2>
        {myDeals.deals.length === 0 ? (
          <p className="rounded-2xl border border-dashed border-line p-4 text-sm text-ink-soft">Rani didn&apos;t find an active offer you&apos;re promoting. {hasAnything ? "Your rivals have deals live above — post one to keep pace." : "Post a sale on your social/Google and Rani will track it here."}</p>
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

      {/* price positioning (secondary) */}
      {priceRows.length > 0 && (
        <section className="card">
          <div className="flex items-center justify-between">
            <h2 className="flex items-center gap-2 font-semibold"><span className="grid h-7 w-7 place-items-center rounded-lg bg-brand-soft text-brand">💸</span>Price positioning</h2>
            <span className="text-xs text-ink-faint">from catalog prices</span>
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
