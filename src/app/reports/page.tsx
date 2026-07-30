import { activeWorkspace } from "@/lib/workspace";
import { ScreenNotReady } from "@/components/ScreenNotReady";
import { ReportToolbar } from "@/components/ReportToolbar";
import { buildWorkspaceReport } from "@/lib/report";
import { labelForProvider } from "@/lib/costs";

export const dynamic = "force-dynamic";
export const metadata = { title: "Report — Ask Rani Insights" };

const usd = (n: number | null | undefined) =>
  n == null ? "—" : `$${Number(n).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

function Card({ title, children, sub }: { title: string; children: React.ReactNode; sub?: string }) {
  return (
    <section className="print-card rounded-xl border border-line bg-surface p-5">
      <div className="mb-3">
        <h2 className="font-medium">{title}</h2>
        {sub && <p className="mt-0.5 text-xs text-ink-faint">{sub}</p>}
      </div>
      {children}
    </section>
  );
}

export default async function ReportsPage() {
  const state = await activeWorkspace();
  if (state.status !== "ok") return <ScreenNotReady state={state} title="Market report" />;

  const r = await buildWorkspaceReport(state.workspace);
  const generated = new Date(r.generatedAt).toLocaleString();

  return (
    <div className="space-y-6 animate-fade-in">
      {/* header + actions */}
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Market report</h1>
          <p className="mt-1 text-sm text-ink-soft">
            {state.workspace.name} · {r.cost.days}-day window · generated {generated}
          </p>
        </div>
        <ReportToolbar />
      </div>

      {/* snapshot */}
      <section className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
        {[
          { label: "Businesses watched", value: r.snapshot.monitoredBusinesses },
          { label: "Competitors", value: r.snapshot.competitors },
          { label: "Offers tracked", value: r.snapshot.offers },
          { label: "Events (30d)", value: r.snapshot.events30d },
          { label: "Open actions", value: r.snapshot.openRecommendations },
          { label: "Reviews seen", value: r.snapshot.reviewsSeen },
        ].map((s) => (
          <div key={s.label} className="print-card rounded-xl border border-line bg-surface p-4">
            <div className="text-2xl font-semibold">{s.value}</div>
            <div className="mt-0.5 text-xs text-ink-faint">{s.label}</div>
          </div>
        ))}
      </section>

      {/* cost */}
      <Card
        title="What monitoring costs"
        sub={`Real per-run cost recorded across every source over the last ${r.cost.days} days.`}
      >
        <div className="grid gap-3 sm:grid-cols-3">
          <div className="rounded-lg bg-surface-sunken p-3">
            <div className="text-xl font-semibold">{usd(r.cost.projectedMonthlyUsd)}</div>
            <div className="text-xs text-ink-faint">projected / month</div>
          </div>
          <div className="rounded-lg bg-surface-sunken p-3">
            <div className="text-xl font-semibold">{usd(r.cost.perBusinessMonthlyUsd)}</div>
            <div className="text-xs text-ink-faint">per business / month</div>
          </div>
          <div className="rounded-lg bg-surface-sunken p-3">
            <div className="text-xl font-semibold">{usd(r.cost.totalUsd)}</div>
            <div className="text-xs text-ink-faint">spent in window</div>
          </div>
        </div>
        {r.cost.byProvider.length > 0 && (
          <table className="mt-4 w-full text-sm">
            <thead>
              <tr className="border-b border-line text-left text-xs text-ink-faint">
                <th className="py-1.5 font-medium">Source</th>
                <th className="py-1.5 text-right font-medium">Runs</th>
                <th className="py-1.5 text-right font-medium">Items</th>
                <th className="py-1.5 text-right font-medium">Cost</th>
              </tr>
            </thead>
            <tbody>
              {r.cost.byProvider.map((p) => (
                <tr key={p.provider} className="border-b border-line/60">
                  <td className="py-1.5">{labelForProvider(p.provider)}</td>
                  <td className="py-1.5 text-right tabular-nums text-ink-soft">{p.runs}</td>
                  <td className="py-1.5 text-right tabular-nums text-ink-soft">{p.items}</td>
                  <td className="py-1.5 text-right tabular-nums font-medium">{usd(p.costUsd)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {r.cost.budgetUsedFraction != null && (
          <p className="mt-3 text-xs text-ink-faint">
            Projected spend is {Math.round(r.cost.budgetUsedFraction * 100)}% of this workspace&apos;s monthly budget.
          </p>
        )}
      </Card>

      {/* pricing */}
      <Card title="Pricing comparison" sub="Distinct priced items per business — you vs. competitors.">
        {r.pricing.length === 0 ? (
          <p className="text-sm text-ink-faint">No priced offers collected yet.</p>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-line text-left text-xs text-ink-faint">
                <th className="py-1.5 font-medium">Business</th>
                <th className="py-1.5 text-right font-medium">Items</th>
                <th className="py-1.5 text-right font-medium">Avg</th>
                <th className="py-1.5 text-right font-medium">Min</th>
                <th className="py-1.5 text-right font-medium">Max</th>
              </tr>
            </thead>
            <tbody>
              {r.pricing.map((p) => (
                <tr key={p.businessId} className={`border-b border-line/60 ${p.isTarget ? "bg-brand-soft/30" : ""}`}>
                  <td className="py-1.5">
                    {p.name} {p.isTarget && <span className="text-xs text-brand">(you)</span>}
                  </td>
                  <td className="py-1.5 text-right tabular-nums text-ink-soft">{p.offers}</td>
                  <td className="py-1.5 text-right tabular-nums font-medium">{usd(p.avgPrice)}</td>
                  <td className="py-1.5 text-right tabular-nums text-ink-soft">{usd(p.minPrice)}</td>
                  <td className="py-1.5 text-right tabular-nums text-ink-soft">{usd(p.maxPrice)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>

      {/* reputation */}
      <Card title="Reputation" sub="Latest ratings we've observed across review sources.">
        {r.reputation.every((x) => x.rating == null && x.reviewsSeen === 0) ? (
          <p className="text-sm text-ink-faint">No reviews collected yet — add a Yelp or Google key to populate this.</p>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-line text-left text-xs text-ink-faint">
                <th className="py-1.5 font-medium">Business</th>
                <th className="py-1.5 text-right font-medium">Rating</th>
                <th className="py-1.5 text-right font-medium">Reviews</th>
              </tr>
            </thead>
            <tbody>
              {r.reputation.map((x) => (
                <tr key={x.businessId} className={`border-b border-line/60 ${x.isTarget ? "bg-brand-soft/30" : ""}`}>
                  <td className="py-1.5">
                    {x.name} {x.isTarget && <span className="text-xs text-brand">(you)</span>}
                  </td>
                  <td className="py-1.5 text-right tabular-nums font-medium">{x.rating != null ? `${x.rating}★` : "—"}</td>
                  <td className="py-1.5 text-right tabular-nums text-ink-soft">
                    {x.reviewCount != null ? x.reviewCount.toLocaleString() : "—"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>

      {/* events */}
      <Card title="Recent market events" sub="What moved in your market, most significant first.">
        {r.events.length === 0 ? (
          <p className="text-sm text-ink-faint">No events in this window.</p>
        ) : (
          <ul className="space-y-2 text-sm">
            {r.events.slice(0, 20).map((e) => (
              <li key={e.id} className="flex gap-2">
                <span className="chip shrink-0 bg-surface-sunken text-ink-soft">{e.type.replace(/_/g, " ")}</span>
                <span className="text-ink-soft">
                  <span className="font-medium text-ink">{e.business}</span> — {e.summary}
                </span>
              </li>
            ))}
          </ul>
        )}
      </Card>

      {/* recommendations */}
      <Card title="Recommended actions" sub="Open recommendations, highest priority first.">
        {r.recommendations.length === 0 ? (
          <p className="text-sm text-ink-faint">No open recommendations.</p>
        ) : (
          <ul className="space-y-3 text-sm">
            {r.recommendations.slice(0, 20).map((rec) => (
              <li key={rec.id}>
                <div className="flex items-center gap-2">
                  <span className="chip bg-brand-soft text-brand">{rec.category}</span>
                  <span className="font-medium">{rec.title}</span>
                </div>
                <p className="mt-0.5 text-ink-soft">{rec.action}</p>
              </li>
            ))}
          </ul>
        )}
      </Card>

      <p className="no-print text-xs text-ink-faint">
        Confidence and source labels appear on each underlying screen (Offers, Feed). This report reflects
        everything collected up to {generated}.
      </p>
    </div>
  );
}
