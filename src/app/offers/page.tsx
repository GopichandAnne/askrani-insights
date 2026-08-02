import { activeWorkspace, workspaceBusinessIds } from "@/lib/workspace";
import { createClient } from "@/lib/supabase/server";
import { ScreenNotReady } from "@/components/ScreenNotReady";
import { TrustChip, ProvenanceBadge } from "@/components/TrustChip";
import { MarketTabs } from "@/components/MarketTabs";

export const dynamic = "force-dynamic";

export default async function OffersPage() {
  const state = await activeWorkspace();
  if (state.status !== "ok") return <ScreenNotReady state={state} title="Offers & pricing" />;

  const ids = await workspaceBusinessIds(state.workspace);
  const supabase = await createClient();
  const { data: offers } = await supabase
    .from("offer")
    .select("id,entity_text,offer_type,pricing,confidence,provenance,observed_at,business_id,business:business_id(canonical_name)")
    .in("business_id", ids.all.length ? ids.all : ["00000000-0000-0000-0000-000000000000"])
    .order("observed_at", { ascending: false })
    .limit(400);

  // group by business, keep latest observation per entity_text
  const byBiz = new Map<string, { name: string; isTarget: boolean; rows: any[] }>();
  for (const o of offers ?? []) {
    const name = (o.business as any)?.canonical_name ?? "Unknown";
    const key = o.business_id as string;
    if (!byBiz.has(key))
      byBiz.set(key, { name, isTarget: key === ids.targetId, rows: [] });
    const bucket = byBiz.get(key)!;
    if (!bucket.rows.some((r) => r.entity_text.toLowerCase() === (o.entity_text as string).toLowerCase())) {
      bucket.rows.push(o);
    }
  }
  const groups = [...byBiz.values()].sort((a, b) => Number(b.isTarget) - Number(a.isTarget));

  // ── price positioning: avg/min/max per business (priced items only) ──
  const priceRows = groups
    .map((g) => {
      const prices = g.rows.map((r) => Number((r.pricing as any)?.amount)).filter((n) => Number.isFinite(n) && n > 0);
      const avg = prices.length ? prices.reduce((a, b) => a + b, 0) / prices.length : null;
      return { name: g.name, isTarget: g.isTarget, count: prices.length, avg, min: prices.length ? Math.min(...prices) : null, max: prices.length ? Math.max(...prices) : null };
    })
    .filter((r) => r.count > 0)
    .sort((a, b) => Number(b.isTarget) - Number(a.isTarget) || (a.avg ?? 0) - (b.avg ?? 0));
  const totalPriced = priceRows.reduce((a, r) => a + r.count, 0);

  // ── item-by-item: same item priced at ≥2 businesses → who's cheapest ──
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9 ]/g, "").replace(/\s+/g, " ").trim();
  const itemMap = new Map<string, { item: string; entries: { name: string; price: number; isTarget: boolean }[] }>();
  for (const g of groups) {
    for (const r of g.rows) {
      const amt = Number((r.pricing as any)?.amount);
      if (!(amt > 0)) continue;
      const key = norm(r.entity_text);
      if (!key) continue;
      const e = itemMap.get(key) ?? { item: r.entity_text as string, entries: [] as { name: string; price: number; isTarget: boolean }[] };
      if (!e.entries.some((x) => x.name === g.name)) e.entries.push({ name: g.name, price: amt, isTarget: g.isTarget });
      itemMap.set(key, e);
    }
  }
  const shared = [...itemMap.values()].filter((e) => e.entries.length >= 2).slice(0, 12);
  const usd = (n: number | null) => (n == null ? "—" : `$${n.toFixed(2)}`);

  const v = state.workspace.vertical;
  const noun = v === "salon" ? "Services and prices" : v === "grocery" ? "Products and prices" : "Menu items and prices";

  return (
    <div className="animate-fade-in space-y-5">
      <div>
        <p className="text-sm font-medium text-brand-deep">Ask Rani Insights</p>
        <h1 className="mt-1 font-display text-3xl font-extrabold tracking-tight">Offers &amp; pricing</h1>
        <p className="mt-1 max-w-2xl text-sm text-ink-soft">
          {noun} for {state.workspace.name} and your competitors, side by side. Each
          one shows where we found it and how sure we are.
        </p>
      </div>

      <MarketTabs />

      {/* price positioning */}
      {totalPriced === 0 ? (
        <div className="card border-dashed">
          {v === "salon" ? (
            <p className="text-sm text-ink-soft">
              <span className="font-semibold text-ink">No prices captured yet.</span> For beauty & spa businesses, prices come from
              your <span className="font-medium text-brand-deep">website service menu</span> and priced promo posts on Instagram/Facebook.
              Make sure your treatments and prices are published online, then re-collect to fill this in.
            </p>
          ) : (
            <p className="text-sm text-ink-soft">
              <span className="font-semibold text-ink">No prices captured yet.</span> Prices come from menus, websites and delivery apps.
              Grocery shelves rarely list prices online — the richest source is <span className="font-medium text-brand-deep">DoorDash / Uber Eats menus</span>.
              Turn on delivery collection (add the Apify delivery actors) and re-collect to fill this in.
            </p>
          )}
        </div>
      ) : (
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

          {shared.length > 0 && (
            <div className="mt-4">
              <h3 className="text-sm font-semibold">Same item, who&apos;s cheapest</h3>
              <ul className="mt-2 space-y-1.5">
                {shared.map((e, i) => {
                  const cheapest = Math.min(...e.entries.map((x) => x.price));
                  return (
                    <li key={i} className="rounded-2xl bg-white/55 p-2.5 text-sm">
                      <div className="font-medium">{e.item}</div>
                      <div className="mt-1 flex flex-wrap gap-1.5">
                        {e.entries.sort((a, b) => a.price - b.price).map((x, j) => (
                          <span key={j} className={`chip ${x.price === cheapest ? "bg-trust-direct/15 text-trust-direct" : "bg-surface-sunken text-ink-soft"}`}>
                            {x.isTarget ? "You" : x.name.split(" ").slice(0, 2).join(" ")} {usd(x.price)}{x.price === cheapest ? " · cheapest" : ""}
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
      )}

      {!groups.length ? (
        <p className="card border-dashed text-sm text-ink-soft">
          No offers saved yet. Run a market analysis to populate this.
        </p>
      ) : (
        <div className="stagger grid gap-4 lg:grid-cols-2">
          {groups.map((g, i) => (
            <div key={i} className={`card card-hover ${g.isTarget ? "ring-1 ring-brand/40" : ""}`}>
              <div className="flex items-center justify-between">
                <span className="font-semibold">
                  {g.name} {g.isTarget && <span className="chip ml-1 bg-brand-soft text-brand">you</span>}
                </span>
                <span className="chip bg-surface-sunken text-ink-faint">{g.rows.length} offers</span>
              </div>
              <ul className="mt-3 divide-y divide-line/50">
                {g.rows.slice(0, 20).map((o) => {
                  const amount = (o.pricing as any)?.amount;
                  return (
                    <li key={o.id} className="flex items-center justify-between gap-2 py-1.5 text-sm">
                      <span className="truncate">{o.entity_text}</span>
                      <span className="flex shrink-0 items-center gap-2">
                        {amount != null && <span className="font-semibold text-brand-deep">${amount}</span>}
                        <TrustChip confidence={Number(o.confidence)} />
                      </span>
                    </li>
                  );
                })}
              </ul>
              {g.rows[0] && (
                <div className="mt-3">
                  <ProvenanceBadge provenance={g.rows[0].provenance} />
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
