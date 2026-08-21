import { activeWorkspace } from "@/lib/workspace";
import { ScreenNotReady } from "@/components/ScreenNotReady";
import { ReportToolbar } from "@/components/ReportToolbar";
import { DeliverySettings } from "@/components/DeliverySettings";
import { buildWorkspaceReport } from "@/lib/report";
import { buildDigest } from "@/lib/digest";
import { emailConfigured } from "@/lib/notify";
import { whatsappConfigured, whatsappBusinessNumber } from "@/lib/whatsapp";
import { REPORT_ON_DEMAND_CREDITS, planOfOrg, cadenceForPlan } from "@/lib/credits";
import { requireOrg } from "@/lib/api";

export const dynamic = "force-dynamic";
export const metadata = { title: "Report — Ask Rani Insights" };

const SOURCE_LABEL: Record<string, string> = { google: "Google", yelp: "Yelp", facebook: "Facebook", tripadvisor: "TripAdvisor", trustpilot: "Trustpilot" };

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

  const auth = await requireOrg();
  const cadence = cadenceForPlan(auth ? await planOfOrg(auth.orgId) : "free");

  const goals = ((state.workspace as { goals?: Record<string, unknown> }).goals ?? {}) as Record<string, unknown>;
  // The report leads with the SAME weekly synthesis Home shows and the PDF/email
  // sends — one report model, not a fourth independent re-aggregation.
  const digest = buildDigest({ name: state.workspace.name, vertical: state.workspace.vertical }, goals);
  const SEV_GROUPS = [["alert", "Needs your attention"], ["opportunity", "Opportunities to grab"], ["fyi", "Good to know"]] as const;
  const emailReady = emailConfigured();
  const whatsappReady = whatsappConfigured();

  return (
    <div className="space-y-6 animate-fade-in">
      {/* header + actions */}
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Market report</h1>
          <p className="mt-1 text-sm text-ink-soft">
            {state.workspace.name} · {r.cost.days}-day window · generated {generated}
          </p>
          <p className="mt-0.5 text-xs text-ink-faint">
            📬 On your plan this report is sent <b className="text-brand-deep">{cadence}</b> by email/WhatsApp{cadence === "weekly" ? " — upgrade for a daily report, or send one now below" : ""}.
          </p>
        </div>
        <ReportToolbar canSend={emailReady || whatsappReady} sendCost={REPORT_ON_DEMAND_CREDITS} />
      </div>

      {/* where it's delivered — email + WhatsApp */}
      <DeliverySettings
        initialEmail={typeof goals.notifyEmail === "string" ? goals.notifyEmail : ""}
        initialWhatsApp={typeof goals.notifyWhatsApp === "string" ? goals.notifyWhatsApp : ""}
        emailReady={emailReady}
        whatsappReady={whatsappReady}
        businessNumber={whatsappBusinessNumber() ?? ""}
      />

      {/* the report itself — the same weekly synthesis that gets emailed/sent */}
      {digest.items.length > 0 && (
        <section className="print-card rounded-xl border border-line bg-surface p-5">
          <h2 className="font-medium">This week — {digest.headline}</h2>
          <p className="mt-0.5 text-xs text-ink-faint">The summary sent to you {cadence}. Grouped by what needs you first.</p>
          <div className="mt-4 space-y-4">
            {SEV_GROUPS.map(([sev, label]) => {
              const group = digest.items.filter((i) => i.severity === sev);
              if (!group.length) return null;
              return (
                <div key={sev}>
                  <div className="text-xs font-semibold uppercase tracking-wide text-brand-deep">{label}</div>
                  <ul className="mt-2 space-y-2">
                    {group.map((it) => (
                      <li key={it.id} className="flex gap-2.5 text-sm">
                        <span aria-hidden>{it.icon}</span>
                        <span><b className="text-ink">{it.title}.</b> <span className="text-ink-soft">{it.detail}</span>{it.href && <a href={it.href} className="no-print ml-1 text-xs font-medium text-brand hover:underline">details →</a>}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              );
            })}
          </div>
        </section>
      )}

      <div className="pt-1"><h2 className="text-xs font-semibold uppercase tracking-wide text-ink-faint">Full breakdown</h2></div>

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
                <th className="py-1.5 font-medium">By source</th>
                <th className="py-1.5 text-right font-medium">Best</th>
                <th className="py-1.5 text-right font-medium">Reviews</th>
              </tr>
            </thead>
            <tbody>
              {r.reputation.map((x) => (
                <tr key={x.businessId} className={`border-b border-line/60 ${x.isTarget ? "bg-brand-soft/30" : ""}`}>
                  <td className="py-1.5">
                    {x.name} {x.isTarget && <span className="text-xs text-brand">(you)</span>}
                  </td>
                  <td className="py-1.5">
                    {x.sources.length ? (
                      <span className="flex flex-wrap gap-1.5">
                        {x.sources.map((s) => (
                          <span key={s.source} className="chip bg-surface-sunken text-ink-soft" title={`${s.reviewCount ?? 0} reviews`}>
                            {SOURCE_LABEL[s.source] ?? s.source} {s.rating}★
                          </span>
                        ))}
                      </span>
                    ) : (
                      <span className="text-ink-faint">—</span>
                    )}
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
        The summary at the top is exactly what's emailed/sent; the breakdown is the detail behind it. Live
        confidence and source labels appear on each underlying screen (Offers, Feed). Reflects everything
        collected up to {generated}.
      </p>
    </div>
  );
}
