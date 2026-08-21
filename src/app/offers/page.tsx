import { activeWorkspace, workspaceBusinessIds } from "@/lib/workspace";
import { createClient } from "@/lib/supabase/server";
import { getOrMakeDeals, getOrMakeMyDeals, type DealItem } from "@/lib/deals";
import { getOrMakePriceGaps, type GapVerdict } from "@/lib/pricegaps";
import { getCompetitorSocial } from "@/lib/social";
import { getOrMakeMenuCompare } from "@/lib/menucompare";
import type { FlyerDeal } from "@/lib/flyers";
import { flyersConfigured } from "@/lib/flyers";
import { quoteFlyerRead, FLYER_READ_COMPETITOR_CAP, planOfOrg, retentionDaysForPlan } from "@/lib/credits";
import { requireOrg } from "@/lib/api";
import { FlyerReadButton } from "@/components/FlyerReadButton";
import { ScreenNotReady } from "@/components/ScreenNotReady";
import { PillarBuilding } from "@/components/PillarBuilding";
import { MarketTabs } from "@/components/MarketTabs";
import { withinBudget } from "@/lib/pillarBudget";

export const dynamic = "force-dynamic";
export const maxDuration = 60; // room for the cold-cache report builds

const SOURCE_LABEL: Record<string, string> = { instagram: "Instagram", facebook: "Facebook", tiktok: "TikTok", youtube: "YouTube", google: "Google", website: "website", doordash: "DoorDash", ubereats: "Uber Eats" };
const sourceLabel = (s?: string) => (s && SOURCE_LABEL[s]) || "online";
const CHAN_LABEL: Record<string, string> = { instagram: "IG", facebook: "FB", tiktok: "TikTok", youtube: "YT" };
const chanLabel = (c: string) => CHAN_LABEL[c] ?? c;
const parseUsd = (s?: string) => { const m = String(s ?? "").match(/\$\s*(\d+(?:\.\d+)?)/) ?? String(s ?? "").match(/(\d+(?:\.\d+)?)/); return m ? Number(m[1]) : null; };
const DAY = 86400000;
const dealDate = (d: { postedAt?: string; seenAt?: string; lastSeen?: string }) => d.postedAt || d.seenAt || d.lastSeen || null;
const agoLabel = (s?: string | null) => { if (!s) return ""; const t = new Date(s).getTime(); if (isNaN(t)) return ""; const d = Math.floor((Date.now() - t) / DAY); return d <= 0 ? "today" : d === 1 ? "1d ago" : `${d}d ago`; };
const WD = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
/** Heuristic cadence from a competitor's dated deal-days: a favoured weekday
 *  and/or a rough interval. Needs ≥4 deal-days spanning ≥10 days to claim a pattern. */
function detectCadence(times: number[]): string | null {
  const days = [...new Set(times.filter((t) => !isNaN(t)).map((t) => Math.floor(t / DAY)))].sort((a, b) => a - b);
  if (days.length < 4) return null;
  const span = days[days.length - 1] - days[0];
  if (span < 10) return null;
  const dow = new Array(7).fill(0);
  for (const d of days) dow[new Date(d * DAY).getUTCDay()]++;
  const top = dow.indexOf(Math.max(...dow));
  const parts: string[] = [];
  if (dow[top] >= 3 && dow[top] / days.length >= 0.4) parts.push(`most ${WD[top]}s`);
  const gaps: number[] = []; for (let i = 1; i < days.length; i++) gaps.push(days[i] - days[i - 1]);
  const avgGap = gaps.reduce((a, b) => a + b, 0) / gaps.length;
  if (avgGap <= 9) parts.push("~weekly"); else if (avgGap <= 16) parts.push("~every 2 weeks");
  const perWeek = days.length / (span / 7);
  if (!parts.length && perWeek >= 2) parts.push(`~${Math.round(perWeek)} deals/week`);
  return parts.length ? parts.join(" · ") : null;
}

interface RivalBundle { rival: string; promos: DealItem[]; priced: FlyerDeal[]; sources: Set<string> }

export default async function OffersPage({ searchParams }: { searchParams: Promise<{ days?: string }> }) {
  const state = await activeWorkspace();
  if (state.status !== "ok") return <ScreenNotReady state={state} title="Offers & deals" />;
  const ws = state.workspace;

  const auth = await requireOrg();
  const retentionDays = retentionDaysForPlan(auth ? await planOfOrg(auth.orgId) : "free");
  const windows = [...new Set([10, 30, 90, retentionDays])].filter((w) => w <= retentionDays).sort((a, b) => a - b);
  const days = Math.min(Math.max(parseInt((await searchParams)?.days ?? "10", 10) || 10, 1), retentionDays);
  const cutoffMs = Date.now() - days * DAY;
  const inWindow = (d: { postedAt?: string; seenAt?: string; lastSeen?: string }) => { const s = dealDate(d); if (!s) return true; const t = new Date(s).getTime(); return isNaN(t) || t >= cutoffMs; };

  const ids = await workspaceBusinessIds(ws);
  const supabase = await createClient();

  const built = await withinBudget(Promise.all([getOrMakeDeals(ws), getOrMakeMyDeals(ws), getOrMakePriceGaps(ws), getCompetitorSocial(ws, days), getOrMakeMenuCompare(ws)]));
  if (!built) return <PillarBuilding title="Offers & deals" subtitle="Comparing prices, promos and deals across your competitors — this first read is finishing in the background." />;
  const [rivalDeals, myDeals, priceGaps, social, menuCompare] = built;
  const allFlyerDeals = ((ws.goals as { flyerDeals?: { deals?: FlyerDeal[] } } | undefined)?.flyerDeals?.deals ?? []) as FlyerDeal[];

  // price-drop detection over FULL history (a competitor lowered an item's price)
  const priceHist = new Map<string, { price: number; seen: number }[]>();
  for (const d of allFlyerDeals) { const n = parseUsd(d.price); if (n == null) continue; const k = `${d.rival}|${d.item}`.toLowerCase(); (priceHist.get(k) ?? priceHist.set(k, []).get(k)!).push({ price: n, seen: new Date(d.seenAt ?? d.postedAt ?? 0).getTime() }); }
  const dropped = new Set<string>();
  for (const [k, arr] of priceHist) { if (arr.length < 2) continue; arr.sort((a, b) => a.seen - b.seen); if (arr[arr.length - 1].price < Math.min(...arr.slice(0, -1).map((x) => x.price))) dropped.add(k); }
  const isDropped = (d: FlyerDeal) => dropped.has(`${d.rival}|${d.item}`.toLowerCase());
  const isNew = (d: { seenAt?: string }) => !!d.seenAt && Date.now() - new Date(d.seenAt).getTime() < 2 * DAY;

  // cadence — computed from FULL dated history (not the window), per competitor
  const datesByRival = new Map<string, number[]>();
  const addDate = (rival: string, s?: string) => { if (!s) return; const t = new Date(s).getTime(); if (!isNaN(t)) (datesByRival.get(rival) ?? datesByRival.set(rival, []).get(rival)!).push(t); };
  for (const d of rivalDeals.deals) addDate(d.rival, d.postedAt);
  for (const d of allFlyerDeals) addDate(d.rival, d.postedAt ?? d.seenAt);
  const cadenceByRival = new Map<string, string>();
  for (const [rival, times] of datesByRival) { const c = detectCadence(times); if (c) cadenceByRival.set(rival, c); }

  // apply the date window
  const flyerDeals = allFlyerDeals.filter(inWindow);
  const windowedPromos = rivalDeals.deals.filter(inWindow);

  // merge everything into ONE bundle per rival (promos + priced flyer items)
  const map = new Map<string, RivalBundle>();
  const bundle = (r: string) => { if (!map.has(r)) map.set(r, { rival: r, promos: [], priced: [], sources: new Set() }); return map.get(r)!; };
  for (const d of windowedPromos) { const b = bundle(d.rival); b.promos.push(d); if (d.source) b.sources.add(d.source); }
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
  const newCount = flyerDeals.filter(isNew).length;
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

      {/* ── HERO: the read + your move (the 3-second answer) ── */}
      <section className="card relative overflow-hidden border-brand/15 bg-gradient-to-br from-brand-soft/40 to-transparent">
        <div className="flex flex-wrap items-center gap-2">
          <span className="chip bg-brand-soft font-semibold text-brand-deep">{rivals.length} {rivals.length === 1 ? "rival" : "rivals"} with offers</span>
          {itemsOnSale > 0 && <span className="chip bg-coral/15 font-semibold text-coral-dark">{itemsOnSale} items on sale</span>}
          {newCount > 0 && <span className="chip bg-trust-direct/15 font-semibold text-trust-direct">🆕 {newCount} new</span>}
          <span className="ml-auto text-xs text-ink-faint">last {days} days</span>
        </div>
        {rivalDeals.summary && <p className="mt-3 max-w-3xl text-base font-medium leading-snug text-ink">{rivalDeals.summary}</p>}
        {rivalDeals.moves.length > 0 && (
          <div className="mt-3 rounded-2xl bg-white/60 p-3.5 shadow-sm ring-1 ring-brand/10">
            <p className="mb-1.5 text-xs font-bold uppercase tracking-wide text-brand-deep">Your move</p>
            <ul className="space-y-1.5 text-sm font-medium text-brand-deep">{rivalDeals.moves.map((m, i) => <li key={i} className="flex gap-1.5"><span className="text-brand">✦</span>{m}</li>)}</ul>
          </div>
        )}
        {!hasAnything && (allFlyerDeals.length > 0 || rivalDeals.deals.length > 0) ? (
          <p className="mt-3 rounded-2xl border border-dashed border-line p-4 text-sm text-ink-soft">
            <span className="font-semibold text-ink">Nothing in the last {days} days.</span> There&apos;s older history — <a href={`?days=${retentionDays}`} className="font-medium text-brand hover:underline">widen to {retentionDays} days</a>, or run a fresh scan below.
          </p>
        ) : !hasAnything && (
          <p className="mt-3 rounded-2xl border border-dashed border-line p-4 text-sm text-ink-soft">
            <span className="font-semibold text-ink">No competitor offers detected yet.</span> Connect your competitors&apos; Instagram/Facebook pages under <span className="font-medium text-brand-deep">Channels</span> and use <b>Read their sale flyers</b> below — their sales show up here as they post them.
          </p>
        )}
      </section>

      {/* ── toolbar: time window + refresh action (utility, recessed) ── */}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="text-xs font-semibold uppercase tracking-wide text-ink-faint">Showing</span>
          {windows.map((w) => (
            <a key={w} href={`?days=${w}`} className={`chip ${days === w ? "bg-brand-gradient text-white" : "bg-surface-sunken text-ink-soft hover:text-brand"}`}>last {w} days</a>
          ))}
          <span className="text-xs text-ink-faint">· plan keeps {retentionDays}d</span>
        </div>
        {canFlyer && (
          <div className="ml-auto flex items-center gap-2">
            <span className="hidden text-xs text-ink-faint sm:inline">🧾 Rani reads sale prices right off their flyer &amp; menu images</span>
            <FlyerReadButton workspaceId={ws.id} cost={flyerCost} />
          </div>
        )}
      </div>

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

      {/* menu / service price comparison — item-level, for bounded-menu verticals */}
      {(menuCompare.overview.length > 0 || menuCompare.matches.length > 0) && (() => {
        const POS: Record<string, { chip: string; label: string }> = {
          cheaper: { chip: "bg-coral/15 text-coral-dark", label: "cheaper than you" },
          pricier: { chip: "bg-trust-direct/15 text-trust-direct", label: "pricier than you" },
          similar: { chip: "bg-surface-sunken text-ink-soft", label: "similar to you" },
        };
        return (
          <section className="card">
            <h2 className="mb-1 flex items-center gap-2 font-semibold"><span className="grid h-7 w-7 place-items-center rounded-lg bg-brand-gradient text-white shadow-brand">💲</span>Menu &amp; service price comparison</h2>
            {menuCompare.summary && <p className="mb-3 max-w-3xl text-sm text-ink-soft">{menuCompare.summary}</p>}
            {menuCompare.overview.length > 0 && (
              <div className="grid gap-2 sm:grid-cols-2">
                {menuCompare.overview.map((o, i) => (
                  <div key={i} className="flex items-start gap-2 rounded-2xl bg-white/55 p-3">
                    <span className={`chip shrink-0 font-semibold ${(POS[o.positioning] ?? POS.similar).chip}`}>{(POS[o.positioning] ?? POS.similar).label}</span>
                    <span className="min-w-0 text-sm"><b className="text-ink">{o.name}</b> <span className="text-ink-soft">— {o.note}</span></span>
                  </div>
                ))}
              </div>
            )}
            {menuCompare.matches.length > 0 && (
              <div className="mt-4">
                <h3 className="mb-2 text-sm font-semibold">Same item, side by side</h3>
                <ul className="space-y-1.5">
                  {menuCompare.matches.map((m, i) => {
                    const cheapest = m.entries[0]?.price;
                    return (
                      <li key={i} className="rounded-2xl bg-white/55 p-2.5 text-sm">
                        <div className="font-medium">{m.item}{m.note ? <span className="ml-1 text-xs font-normal text-ink-faint">· {m.note}</span> : null}</div>
                        <div className="mt-1 flex flex-wrap gap-1.5">
                          {m.entries.map((e, j) => (
                            <span key={j} className={`chip ${e.price === cheapest ? "bg-trust-direct/15 text-trust-direct" : e.isYou ? "bg-brand-soft text-brand-deep" : "bg-surface-sunken text-ink-soft"}`}>
                              {e.isYou ? "You" : e.business.split(" ").slice(0, 2).join(" ")} ${e.price.toFixed(2)}{e.price === cheapest ? " · cheapest" : ""}
                            </span>
                          ))}
                        </div>
                      </li>
                    );
                  })}
                </ul>
              </div>
            )}
          </section>
        );
      })()}

      {/* lowest prices — a quick hit-list of the sharpest prices to match */}
      {lowest.length > 0 && (
        <section className="card">
          <h2 className="mb-1 flex items-center gap-2 font-semibold"><span className="grid h-7 w-7 place-items-center rounded-lg bg-coral/15 text-coral-dark">🔻</span>Sharpest prices to match</h2>
          <p className="mb-3 text-xs text-ink-faint">The lowest prices Rani spotted on rivals&apos; flyers — the ones to match or beat.</p>
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

      {/* one merged card per rival — what each rival is actually running */}
      {rivals.length > 0 && (
        <div>
          <h2 className="mb-2 flex items-center gap-2 font-semibold"><span className="grid h-7 w-7 place-items-center rounded-lg bg-brand-soft text-brand">🏪</span>What each rival is running</h2>
          <div className="grid gap-4 lg:grid-cols-2">
          {rivals.map((r, gi) => {
            const link = r.priced.find((d) => d.postUrl || d.imageUrl)?.postUrl || r.priced.find((d) => d.imageUrl)?.imageUrl || r.promos.find((d) => d.url)?.url;
            return (
              <div key={gi} className="card">
                <div className="flex items-center justify-between gap-2">
                  <span className="font-semibold">{r.rival}</span>
                  <span className="flex flex-wrap gap-1">{[...r.sources].map((s) => <span key={s} className="chip bg-surface-sunken text-ink-faint">{sourceLabel(s)}</span>)}</span>
                </div>
                {cadenceByRival.get(r.rival) && (
                  <p className="mt-1 text-xs font-medium text-brand-deep">🗓️ Runs deals {cadenceByRival.get(r.rival)}</p>
                )}
                {r.promos.length > 0 && (
                  <div className="mt-2 flex flex-wrap gap-1.5">
                    {r.promos.slice(0, 4).map((d, i) => <span key={i} className="chip bg-coral/15 text-coral-dark">🏷️ {d.deal}{d.when ? ` · ${d.when}` : ""}{agoLabel(d.postedAt) ? <span className="ml-1 opacity-70">· {agoLabel(d.postedAt)}</span> : null}</span>)}
                  </div>
                )}
                {r.priced.length > 0 && (
                  <ul className="mt-3 divide-y divide-line/50">
                    {r.priced.slice(0, 8).map((d, i) => (
                      <li key={i} className="flex items-center justify-between gap-2 py-1.5 text-sm">
                        <span className="flex min-w-0 items-center gap-1.5 truncate text-ink">
                          {isNew(d) && <span className="chip shrink-0 bg-trust-direct/15 px-1.5 py-0 text-[10px] font-bold text-trust-direct">NEW</span>}
                          {isDropped(d) && <span className="chip shrink-0 bg-coral/15 px-1.5 py-0 text-[10px] font-bold text-coral-dark">⬇ DROP</span>}
                          <span className="truncate">{d.item}{d.terms ? <span className="text-ink-faint"> · {d.terms}</span> : null}</span>
                        </span>
                        <span className="flex shrink-0 items-center gap-2">
                          {agoLabel(dealDate(d)) && <span className="text-[11px] text-ink-faint">{agoLabel(dealDate(d))}</span>}
                          {d.price && <span className="font-semibold text-coral-dark">{d.price}</span>}
                        </span>
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

      {/* ── secondary: how rivals are marketing (not an offer signal) — the fuller view lives on Competitors ── */}
      {social.rows.some((r) => r.engagement > 0 || r.channels.length > 0 || r.reviews) && (
        <details className="card group">
          <summary className="flex cursor-pointer list-none items-center gap-2 font-semibold">
            <span className="grid h-7 w-7 place-items-center rounded-lg bg-surface-sunken text-ink-soft">📡</span>
            How rivals are marketing
            <span className="ml-1 text-xs font-normal text-ink-faint">followers · reviews · content — beyond offers</span>
            <span className="ml-auto text-xs font-normal text-ink-faint transition-transform group-open:rotate-180">▾</span>
          </summary>
          <p className="mb-3 mt-2 text-xs text-ink-faint">A quick read on who&apos;s gaining ground over the last {days} days. The full per-rival view is on <a href="/competitors" className="font-medium text-brand hover:underline">Competitors</a>.</p>
          <div className="grid gap-3 md:grid-cols-2">
            {social.rows.filter((r) => r.engagement > 0 || r.channels.length > 0 || r.reviews).slice(0, 8).map((r, i) => (
              <div key={i} className="rounded-2xl bg-white/55 p-3.5">
                <div className="flex items-center justify-between gap-2">
                  <span className="font-semibold">{r.rival}</span>
                  {r.trendPct != null && <span className={`chip ${r.trendPct >= 0 ? "bg-trust-direct/15 text-trust-direct" : "bg-coral/15 text-coral-dark"}`}>{r.trendPct >= 0 ? "▲" : "▼"} {Math.abs(r.trendPct)}% engagement</span>}
                </div>
                {r.channels.length > 0 && (
                  <div className="mt-1.5 flex flex-wrap gap-1.5">
                    {r.channels.map((c) => (
                      <span key={c.channel} className="chip bg-surface-sunken text-ink-soft">👥 {chanLabel(c.channel)} {c.followers.toLocaleString()}{c.delta ? <b className={c.delta >= 0 ? " text-trust-direct" : " text-coral-dark"}> {c.delta >= 0 ? "+" : ""}{c.delta.toLocaleString()}</b> : null}</span>
                    ))}
                  </div>
                )}
                <div className="mt-1.5 flex flex-wrap gap-x-3 gap-y-1 text-xs text-ink-soft">
                  {r.reviews && r.reviews.count > 0 && <span>⭐ {r.reviews.rating ?? "—"} · {r.reviews.count.toLocaleString()} reviews{r.reviews.countDelta ? <b className="text-trust-direct"> +{r.reviews.countDelta}</b> : null}</span>}
                  {r.posts > 0 && <span>📝 {r.posts} posts</span>}
                  {r.topFormat && <span>🎬 {r.topFormat === "video" ? "reels/video work best" : "images work best"}</span>}
                </div>
                {r.topPost && (
                  <div className="mt-2 rounded-xl bg-surface-sunken/60 p-2 text-xs">
                    <span className="font-semibold text-brand-deep">Top post</span> <span className="text-ink-soft">{r.topPost.caption || "(no caption)"}</span>
                    {r.topPost.url && <a href={r.topPost.url} target="_blank" rel="noreferrer" className="ml-1 font-medium text-brand hover:underline">↗</a>}
                  </div>
                )}
              </div>
            ))}
          </div>
          <p className="mt-2 text-[11px] text-ink-faint">Follower &amp; review history builds each scan — deltas appear once there are two dated points.</p>
        </details>
      )}

      {/* raw numbers — collapsed by default, for the owner who wants the underlying catalog spread */}
      {priceRows.length > 0 && (
        <details className="card group">
          <summary className="flex cursor-pointer list-none items-center gap-2 font-semibold">
            <span className="grid h-7 w-7 place-items-center rounded-lg bg-surface-sunken text-ink-soft">💸</span>
            Price positioning
            <span className="ml-1 text-xs font-normal text-ink-faint">the raw catalog spread</span>
            <span className="ml-auto text-xs font-normal text-ink-faint transition-transform group-open:rotate-180">▾</span>
          </summary>
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
        </details>
      )}
    </div>
  );
}
