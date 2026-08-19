import { Fragment } from "react";
import { activeWorkspace } from "@/lib/workspace";
import { getOrMakeFindabilityReport, type FindabilityReport } from "@/lib/findability";
import { ScreenNotReady } from "@/components/ScreenNotReady";

export const dynamic = "force-dynamic";
export const maxDuration = 45;

const INTENT_LABEL: Record<string, string> = { everyday: "Everyday", urgent: "Urgent", high_value: "High-value \u{1F4B0}" };
const INTENTS = ["everyday", "urgent", "high_value"] as const;

function rankChip(rank: number | null): { cls: string; txt: string } {
  if (rank == null) return { cls: "bg-trust-low/12 text-trust-low", txt: "—" };
  if (rank <= 3) return { cls: "bg-trust-direct/15 text-trust-direct", txt: `#${rank}` };
  if (rank <= 7) return { cls: "bg-coral/15 text-coral-dark", txt: `#${rank}` };
  return { cls: "bg-trust-low/12 text-trust-low", txt: `#${rank}` };
}

/** Delta where POSITIVE means improvement (rank rose / score up). */
function Trend({ delta, className = "" }: { delta: number | null; className?: string }) {
  if (delta == null || delta === 0) return <span className={`text-xs font-semibold text-ink-faint ${className}`}>—</span>;
  const up = delta > 0;
  return <span className={`text-xs font-semibold ${up ? "text-trust-direct" : "text-trust-low"} ${className}`}>{up ? "▲" : "▼"} {Math.abs(delta)}</span>;
}

const shortTerm = (t: string) => t.replace(/\s*\b\d{5}\b\s*$/, "").trim().replace(/^(.{26}).+/, "$1…");

export default async function FindabilityPage() {
  const state = await activeWorkspace();
  if (state.status !== "ok") return <ScreenNotReady state={state} title="Findability" />;
  const report: FindabilityReport = await getOrMakeFindabilityReport(state.workspace);

  return (
    <div className="animate-fade-in space-y-6">
      <div>
        <p className="text-sm font-medium text-brand-deep">Ask Rani Insights</p>
        <h1 className="mt-1 font-display text-3xl font-extrabold tracking-tight">Findability</h1>
        <p className="mt-1 max-w-2xl text-sm text-ink-soft">
          Where customers find you — your rank in Google search for the terms they actually type, scored against your real competitors.
        </p>
      </div>

      {report.empty ? (
        <div className="card border-dashed">
          <p className="text-sm text-ink-soft">
            <span className="font-semibold text-ink">Not tracked yet.</span> Once the weekly search scan runs, you&apos;ll see where you rank for the
            searches customers use to find a business like yours — and exactly how you stack up against your competitors.
          </p>
        </div>
      ) : (
        <>
          {/* Score + headline metrics */}
          <div className="card">
            <div className="flex flex-wrap items-start gap-x-12 gap-y-6">
              <div>
                <p className="text-xs font-semibold uppercase tracking-wide text-ink-faint">Findability score</p>
                <div className="mt-1 flex items-end gap-2">
                  <span className="font-display text-5xl font-extrabold text-brand-deep">{report.score}</span>
                  <span className="pb-1.5 text-lg text-ink-faint">/100</span>
                  {report.scoreDelta != null && <span className="pb-2"><Trend delta={report.scoreDelta} /></span>}
                </div>
                <span className="mt-2 flex h-1.5 w-44 overflow-hidden rounded-full bg-surface-sunken">
                  <span className="block h-full rounded-full bg-brand-gradient" style={{ width: `${report.score}%` }} />
                </span>
                <p className="mt-1.5 text-xs text-ink-faint">
                  Position <b className="text-ink-soft">{report.breakdown.position}</b> · Coverage <b className="text-ink-soft">{report.breakdown.coverage}</b> · Momentum <b className="text-ink-soft">{report.breakdown.momentum}</b>
                </p>
              </div>

              <div className="flex flex-wrap gap-x-10 gap-y-5">
                <div>
                  <p className="text-xs font-semibold uppercase tracking-wide text-ink-faint">Avg position</p>
                  <div className="mt-1 flex items-end gap-2">
                    <span className="font-display text-3xl font-extrabold text-ink">{report.avgPosition != null ? `#${report.avgPosition}` : "—"}</span>
                    {report.avgPositionDelta != null && <span className="pb-1"><Trend delta={report.avgPositionDelta} /></span>}
                  </div>
                  <p className="mt-0.5 text-xs text-ink-faint">across {report.keywordCount} searches</p>
                </div>
                <div>
                  <p className="text-xs font-semibold uppercase tracking-wide text-ink-faint">Top-3 coverage</p>
                  <span className="mt-1 block font-display text-3xl font-extrabold text-ink">{report.coverage.inTop3}<span className="text-xl text-ink-faint">/{report.coverage.total}</span></span>
                  <p className="mt-0.5 text-xs text-ink-faint">in the local pack</p>
                </div>
                {report.biggestSlip && (
                  <div>
                    <p className="text-xs font-semibold uppercase tracking-wide text-ink-faint">Biggest slip</p>
                    <span className="mt-1 block max-w-[10rem] truncate font-display text-xl font-extrabold text-trust-low">{shortTerm(report.biggestSlip.term)}</span>
                    <p className="mt-0.5 text-xs text-ink-faint">
                      {report.biggestSlip.from != null
                        ? `#${report.biggestSlip.from} → #${report.biggestSlip.to ?? "—"}`
                        : `now ${report.biggestSlip.to != null ? `#${report.biggestSlip.to}` : "not ranking"}`}
                    </p>
                  </div>
                )}
              </div>
            </div>
          </div>

          {/* What to do */}
          {report.recommendation && (
            <div className="card">
              <div className="flex items-start gap-3">
                <span className="grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-brand text-sm text-white">💡</span>
                <div>
                  <p className="text-xs font-semibold uppercase tracking-wide text-brand-deep">What to do</p>
                  <p className="mt-1 text-sm text-ink">{report.recommendation}</p>
                </div>
              </div>
            </div>
          )}

          {/* Rank by search term, grouped by intent */}
          <div className="card">
            <div className="mb-3 flex items-center gap-2">
              <span className="grid h-7 w-7 place-items-center rounded-lg bg-brand-soft text-brand">🔎</span>
              <h2 className="font-display text-lg font-bold">Your rank by search term</h2>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-line text-left text-[11px] uppercase tracking-wide text-ink-faint">
                    <th className="w-1/2 pb-2 font-semibold">Search customers type</th>
                    <th className="pb-2 font-semibold">You</th>
                    <th className="pb-2 font-semibold">Top rival</th>
                    <th className="pb-2 font-semibold">Trend</th>
                  </tr>
                </thead>
                <tbody>
                  {INTENTS.filter((it) => report.keywords.some((k) => k.intent === it)).map((intent) => (
                    <Fragment key={intent}>
                      <tr>
                        <td colSpan={4} className="pb-1 pt-3 text-[11px] font-bold uppercase tracking-wide text-ink-soft">{INTENT_LABEL[intent]}</td>
                      </tr>
                      {report.keywords.filter((k) => k.intent === intent).map((k) => {
                        const chip = rankChip(k.yourRank);
                        return (
                          <tr key={`${intent}-${k.term}`} className="border-b border-line/60">
                            <td className="py-2 pr-2 text-ink">{shortTerm(k.term)}{!k.confidence && <span className="ml-1 text-ink-faint" title="volatile — averaged">~</span>}</td>
                            <td className="py-2"><span className={`chip ${chip.cls} font-mono`}>{chip.txt}</span></td>
                            <td className="py-2 pr-2 text-xs text-ink-soft">{k.topCompetitor ? `${k.topCompetitor}` : "—"}</td>
                            <td className="py-2"><Trend delta={k.trend} /></td>
                          </tr>
                        );
                      })}
                    </Fragment>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          {/* Share of local search */}
          {report.share.length > 1 && (
            <div className="card">
              <div className="mb-3 flex items-center gap-2">
                <span className="grid h-7 w-7 place-items-center rounded-lg bg-brand-soft text-brand">⚖️</span>
                <h2 className="font-display text-lg font-bold">Share of local search</h2>
                <span className="text-xs text-ink-faint">top-3 across all terms</span>
              </div>
              <div className="space-y-2">
                {report.share.map((s) => (
                  <div key={s.name} className="flex items-center gap-3">
                    <span className={`w-40 shrink-0 truncate text-sm ${s.isYou ? "font-semibold text-brand-deep" : "text-ink-soft"}`}>{s.name}</span>
                    <span className="h-2.5 flex-1 overflow-hidden rounded-full bg-surface-sunken">
                      <span className={`block h-full rounded-full ${s.isYou ? "bg-brand-gradient" : "bg-ink-faint/35"}`} style={{ width: `${Math.round((s.topThree / Math.max(1, s.total)) * 100)}%` }} />
                    </span>
                    <span className="w-12 shrink-0 text-right text-xs tabular-nums text-ink-faint">{s.topThree}/{s.total}</span>
                  </div>
                ))}
              </div>
            </div>
          )}

          <p className="text-xs text-ink-faint">
            Search rank is measured near your location and averaged over repeated checks; it&apos;s a close proxy for the Google Maps local pack, refreshed weekly.
          </p>
        </>
      )}
    </div>
  );
}
