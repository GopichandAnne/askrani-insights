import Link from "next/link";
import type { Scorecard, MetricScore } from "@/lib/scorecard";
import { ScoreRings } from "@/components/ScoreRings";

/**
 * Compact "where you stand" strip for the top of Today — the same competitive
 * scorecard intelligence (buildScorecard), condensed to a glance: the rings hero,
 * position score + rank, Rani's one-line read, and a per-metric ahead/behind row.
 * Pure representation of data the scorecard already computes; the full breakdown,
 * heatmap and plan stay on /scorecard (linked). Renders nothing until there's a
 * real composite, so a thin/collecting workspace never shows an empty shell.
 */

const COLOR: Record<MetricScore["color"], string> = { amber: "#d9930a", green: "#12a06f", violet: "#6366f1", coral: "#e2560b", teal: "#0d9488" };

export function BriefPosition({ sc }: { sc: Scorecard }) {
  if (sc.empty || sc.composite.you == null) return null;
  const { you, avg, rank, total } = sc.composite;
  const aheadCount = sc.metrics.filter((m) => m.you != null && m.avg != null && m.you >= m.avg).length;
  const scored = sc.metrics.filter((m) => m.you != null && m.avg != null);

  return (
    <section className="card">
      <div className="mb-3 flex items-center justify-between gap-3">
        <h2 className="flex items-center gap-2 text-sm font-semibold text-ink">
          <span className="grid h-7 w-7 place-items-center rounded-lg bg-brand-soft text-brand">📍</span>
          Where you stand
        </h2>
        <Link href="/scorecard" className="shrink-0 text-xs font-semibold text-brand-deep hover:underline">Full breakdown →</Link>
      </div>

      <div className="grid gap-5 sm:grid-cols-[190px_1fr] sm:items-center">
        {/* rings hero — condensed; a touch larger on phones where it's the lead element */}
        <div>
          <div className="mx-auto w-full max-w-[220px] sm:max-w-[190px]"><ScoreRings metrics={sc.metrics} score={you} /></div>
          <p className="mt-1 text-center font-mono text-[10px] font-bold uppercase tracking-wider text-ink-faint">
            Position score / 100{rank ? ` · #${rank} of ${total}` : ""}
          </p>
        </div>

        {/* read + per-metric ahead/behind */}
        <div>
          {sc.headline && (
            <p className="mb-3 text-sm"><span className="font-semibold text-ink">Rani&apos;s read:</span> <span className="text-ink-soft">{sc.headline}</span></p>
          )}
          <div className="grid grid-cols-2 gap-x-4 gap-y-2 sm:grid-cols-3">
            {sc.metrics.map((m) => {
              const state = m.you == null || m.avg == null ? "none" : m.you >= m.avg ? "ahead" : "behind";
              return (
                <div key={m.key} className="min-w-0">
                  <div className="flex items-center gap-1.5 text-[11px] font-medium text-ink-soft">
                    <span className="h-2 w-2 shrink-0 rounded-sm" style={{ background: COLOR[m.color] }} />
                    <span className="truncate">{m.label}</span>
                  </div>
                  <div className="mt-0.5 flex items-baseline gap-1.5">
                    <span className="font-display text-lg font-extrabold tabular-nums text-brand-deep">{m.you ?? "—"}</span>
                    {state === "ahead" && <span className="text-[10px] font-semibold text-trust-direct">▲ ahead</span>}
                    {state === "behind" && <span className="text-[10px] font-semibold text-coral-dark">▼ mkt {m.avg}</span>}
                    {state === "none" && <span className="text-[10px] text-ink-faint">no avg</span>}
                  </div>
                </div>
              );
            })}
          </div>
          {scored.length > 0 && (
            <p className="mt-3 text-[11px] text-ink-faint">
              Ahead of the market on <b className="text-ink-soft">{aheadCount}</b> of <b className="text-ink-soft">{scored.length}</b> tracked metrics.
            </p>
          )}
        </div>
      </div>
    </section>
  );
}
