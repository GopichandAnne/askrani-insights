import { activeWorkspace } from "@/lib/workspace";
import { ScreenNotReady } from "@/components/ScreenNotReady";
import { CollectingScreen } from "@/components/CollectingScreen";
import { collectionActive } from "@/lib/jobs";
import { buildScorecard, type MetricScore, type BizScore } from "@/lib/scorecard";
import { ScoreRings } from "@/components/ScoreRings";
import { DraftButton } from "@/components/DraftButton";

export const dynamic = "force-dynamic";
export const maxDuration = 45;
export const metadata = { title: "You vs Your Market — Ask Rani Insights" };

const COLOR: Record<MetricScore["color"], string> = { amber: "#d9930a", green: "#12a06f", violet: "#6366f1", teal: "#0d9488" };

function Bullet({ m }: { m: MetricScore }) {
  const { you, avg } = m;
  return (
    <div className="card">
      <div className="flex items-center gap-2 text-sm font-medium text-ink-soft"><span className="h-2.5 w-2.5 rounded-sm" style={{ background: COLOR[m.color] }} />{m.label}</div>
      <div className="mt-1.5 font-display text-2xl font-extrabold text-brand-deep">{you ?? "—"}<span className="text-sm font-semibold text-ink-faint"> /100</span></div>
      <div className="relative mt-2 h-4 overflow-hidden rounded-md bg-surface-sunken">
        <span className="absolute inset-y-0 left-0 bg-coral/10" style={{ width: "40%" }} />
        <span className="absolute inset-y-0 right-0 bg-trust-direct/10" style={{ left: "60%" }} />
        {you != null && <span className="absolute inset-y-1 left-0 rounded bg-brand-gradient" style={{ width: `${Math.max(2, Math.min(100, you))}%` }} />}
        {avg != null && <span className="absolute -inset-y-0.5 w-[2.5px] rounded bg-ink" style={{ left: `${Math.min(100, avg)}%` }} />}
      </div>
      <div className="mt-2 text-xs">
        {you == null || avg == null ? <span className="text-ink-faint">no market avg</span>
          : you >= avg ? <span className="chip bg-trust-direct/15 text-trust-direct">▲ ahead · mkt {avg}</span>
          : <span className="chip bg-coral/15 text-coral-dark">▼ behind · mkt {avg}</span>}
      </div>
    </div>
  );
}

function Heatmap({ businesses, metrics }: { businesses: BizScore[]; metrics: MetricScore[] }) {
  const cell = (v: number | null) => v == null ? { bg: "transparent", txt: "—" } : { bg: `rgba(13,148,136,${(0.1 + (v / 100) * 0.55).toFixed(2)})`, txt: String(v) };
  return (
    <div className="overflow-x-auto">
      <table className="w-full border-separate text-sm" style={{ borderSpacing: "3px" }}>
        <thead>
          <tr>
            <th></th>
            {metrics.map((m) => <th key={m.key} className="px-1 pb-1 text-center font-mono text-[10px] font-bold uppercase tracking-wide text-ink-faint">{m.label.split(" ")[0]}</th>)}
            <th className="px-1 pb-1 text-center font-mono text-[10px] font-bold uppercase tracking-wide text-ink-faint">Overall</th>
          </tr>
        </thead>
        <tbody>
          {businesses.slice(0, 8).map((b, i) => (
            <tr key={i}>
              <td className={`whitespace-nowrap pr-2 text-xs ${b.isYou ? "font-bold text-ink" : "font-medium text-ink-soft"}`}>{b.name}{b.isYou ? " · you" : ""}</td>
              {metrics.map((m) => { const c = cell(b.scores[m.key]); return <td key={m.key} className={`rounded-lg px-2 py-2 text-center text-xs font-bold tabular-nums text-ink ${b.isYou ? "ring-2 ring-inset ring-brand" : ""}`} style={{ background: c.bg }}>{c.txt}</td>; })}
              {(() => { const c = cell(b.composite); return <td className={`rounded-lg px-2 py-2 text-center text-xs font-extrabold tabular-nums text-ink ${b.isYou ? "ring-2 ring-inset ring-brand" : ""}`} style={{ background: c.bg }}>{c.txt}</td>; })()}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

const MOVE: Record<MetricScore["key"], (avg: number) => { title: string; why: string; context: string }> = {
  findability: (a) => ({ title: "Climb Google search", why: `You're behind the market (avg ${a}) on findability — post weekly and add the categories the leaders rank on.`, context: "Findability gap vs market" }),
  social: (a) => ({ title: "Show up on social", why: `Rivals average ${a} on social reach and you're below — post 2–3× a week and lead with your wins.`, context: "Social reach gap vs market" }),
  rating: (a) => ({ title: "Lift your rating", why: `Your rating trails the market (avg ${a}) — ask your happiest regulars for a Google review this week.`, context: "Rating gap vs market" }),
  price: (a) => ({ title: "Sharpen your pricing", why: `You look pricier than the market (avg ${a}) on tracked items — run a clearly-priced value item to pull footfall.`, context: "Price gap vs market" }),
};

function ActionPlan({ metrics }: { metrics: MetricScore[] }) {
  const behind = metrics.filter((m) => m.you != null && m.avg != null && m.you < m.avg)
    .sort((a, b) => (a.you! - a.avg!) - (b.you! - b.avg!)).slice(0, 3);
  if (!behind.length) return null;
  return (
    <section className="card">
      <h2 className="mb-1 flex items-center gap-2 font-semibold"><span className="grid h-7 w-7 place-items-center rounded-lg bg-brand-gradient text-white shadow-brand">🎯</span>Your plan to beat them</h2>
      <p className="mb-3 text-xs text-ink-faint">Ranked by your biggest gaps to the market.</p>
      <div className="space-y-2.5">
        {behind.map((m, i) => { const mv = MOVE[m.key](m.avg!); return (
          <div key={i} className="flex flex-wrap items-start gap-x-3 gap-y-2 rounded-2xl bg-white/55 p-3.5">
            <span className="grid h-6 w-6 shrink-0 place-items-center rounded-lg bg-brand-gradient text-xs font-bold text-white">{i + 1}</span>
            <div className="min-w-0 flex-1"><p className="text-sm font-semibold text-ink">{mv.title}</p><p className="mt-0.5 text-sm text-ink-soft">{mv.why}</p></div>
            <DraftButton move={`${mv.title}: ${mv.why}`} context={mv.context} />
          </div>
        ); })}
      </div>
    </section>
  );
}

export default async function ScorecardPage() {
  const state = await activeWorkspace();
  if (state.status !== "ok") return <ScreenNotReady state={state} title="You vs Your Market" />;
  if (await collectionActive(state.workspace.id)) return <CollectingScreen workspaceId={state.workspace.id} title="You vs Your Market" />;
  const sc = await buildScorecard(state.workspace);

  return (
    <div className="animate-fade-in space-y-6">
      <header>
        <p className="text-sm font-medium text-brand-deep">Ask Rani Insights</p>
        <h1 className="mt-1 font-display text-3xl font-extrabold tracking-tight">You vs Your Market</h1>
        <p className="mt-1 max-w-2xl text-sm text-ink-soft">How you stack up against your competitors — rating, price, social reach and findability — at a glance, with a plan to beat them.</p>
      </header>

      {sc.empty ? (
        <div className="card border-dashed">
          <p className="text-sm text-ink-soft"><span className="font-semibold text-ink">Not enough data yet.</span> Once we&apos;ve collected ratings, prices and listings across your market, your scorecard fills in — refresh from the Week page to kick it off.</p>
        </div>
      ) : (
        <>
          <section className="card">
            <div className="grid gap-6 md:grid-cols-[300px_1fr] md:items-center">
              <div>
                <ScoreRings metrics={sc.metrics} score={sc.composite.you} />
                <p className="mt-1 text-center font-mono text-[11px] font-bold uppercase tracking-wider text-ink-faint">Position score / 100{sc.composite.rank ? ` · #${sc.composite.rank} of ${sc.composite.total}` : ""}</p>
                <div className="mt-3 flex flex-wrap justify-center gap-x-4 gap-y-1 text-[11px] text-ink-soft">
                  <span className="inline-flex items-center gap-1.5"><span className="inline-block h-2.5 w-2.5 rounded-sm" style={{ background: "linear-gradient(90deg,#0d9488,#12a06f)" }} />You</span>
                  <span className="inline-flex items-center gap-1.5"><span className="inline-block h-3 w-[3px] rounded-sm bg-ink-soft" />Market avg</span>
                  <span className="inline-flex items-center gap-1.5"><span className="inline-block h-2.5 w-2.5 rounded-full ring-2 ring-white" style={{ background: "#eab308" }} />Leader</span>
                </div>
                <div className="mt-3 grid grid-cols-2 gap-x-4 gap-y-1.5 border-t border-line/60 pt-3 text-xs text-ink-soft">
                  {sc.metrics.map((m) => <span key={m.key} className="flex items-center gap-2"><span className="h-2.5 w-2.5 rounded-sm" style={{ background: COLOR[m.color] }} />{m.label}<b className="ml-auto font-mono tabular-nums text-ink">{m.you ?? "—"}</b></span>)}
                  <span className="col-span-2 self-center text-[11px] text-ink-faint">outer → inner ring</span>
                </div>
              </div>
              <div>
                {sc.headline && <p className="mb-3 text-sm"><span className="font-semibold text-ink">Rani&apos;s read:</span> <span className="text-ink-soft">{sc.headline}</span></p>}
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead><tr className="border-b border-line text-left text-[11px] uppercase tracking-wide text-ink-faint"><th className="pb-2 font-medium">Metric</th><th className="pb-2 text-right font-medium">You</th><th className="pb-2 text-right font-medium">Avg</th><th className="pb-2 text-right font-medium">Best</th><th className="pb-2 text-right font-medium">Gap to best</th></tr></thead>
                    <tbody>
                      {sc.metrics.map((m) => {
                        const gap = m.you != null && m.best != null ? m.you - m.best : null;
                        return (
                          <tr key={m.key} className="border-b border-line/60">
                            <td className="py-2"><span className="inline-flex items-center gap-2"><span className="h-2.5 w-2.5 rounded-sm" style={{ background: COLOR[m.color] }} />{m.label}</span></td>
                            <td className="py-2 text-right font-bold tabular-nums">{m.you ?? "—"}</td>
                            <td className="py-2 text-right tabular-nums text-ink-soft">{m.avg ?? "—"}</td>
                            <td className="py-2 text-right tabular-nums text-ink-soft">{m.best ?? "—"}{m.bestName ? <span className="ml-1 text-[10px] text-ink-faint">{m.bestName.split(" ")[0]}</span> : ""}</td>
                            <td className={`py-2 text-right font-semibold tabular-nums ${gap == null ? "text-ink-faint" : gap >= 0 ? "text-trust-direct" : "text-coral-dark"}`}>{gap == null ? "—" : gap >= 0 ? `+${gap} ★` : gap}</td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </div>
            </div>
          </section>

          <section className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            {sc.metrics.map((m) => <Bullet key={m.key} m={m} />)}
          </section>

          <section className="card">
            <h2 className="mb-1 flex items-center gap-2 font-semibold"><span className="grid h-7 w-7 place-items-center rounded-lg bg-brand-soft text-brand">📊</span>The whole field</h2>
            <p className="mb-3 text-xs text-ink-faint">Every business across every metric — you highlighted, darker = stronger.</p>
            <Heatmap businesses={sc.businesses} metrics={sc.metrics} />
          </section>

          <ActionPlan metrics={sc.metrics} />

          <p className="text-center text-xs text-ink-faint">Scores are 0–100, computed from ratings, tracked prices, social following and Google search share across your market. AI-search visibility joins as a fifth ring soon.</p>
        </>
      )}
    </div>
  );
}
