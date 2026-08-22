import type { YouReputation } from "@/lib/you";

/**
 * Where you rank on rating — a compact ranked dot-plot. One row per business
 * (best-first), a dot on a shared, zoomed rating axis, your row highlighted, and
 * the market average drawn as a vertical line across every row. Turns "#5 of 6"
 * from a sentence into something you can see. Pure/server-rendered; direct labels
 * (name + value on every row) so identity never rests on color alone.
 */
export function RatingRankChart({ peers, marketAvg }: { peers: YouReputation["peers"]; marketAvg: number | null }) {
  const rated = peers.filter((p) => typeof p.rating === "number");
  if (rated.length < 2) return null; // nothing to rank against

  // zoom the axis to the data so small rating gaps are visible (ratings cap at 5)
  const values = rated.map((p) => p.rating).concat(marketAvg != null ? [marketAvg] : []);
  const lo = Math.max(0, Math.floor((Math.min(...values) - 0.25) * 10) / 10);
  const hi = 5;
  const span = hi - lo || 1;
  const pct = (v: number) => `${Math.max(0, Math.min(100, ((v - lo) / span) * 100))}%`;
  const rows = [...rated].sort((a, b) => b.rating - a.rating);

  return (
    <div className="mt-4 border-t border-line/60 pt-4">
      <div className="mb-3 flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <p className="text-xs font-semibold uppercase tracking-wide text-ink-faint">How you rank on rating</p>
        {marketAvg != null && (
          <p className="flex items-center gap-1.5 text-[11px] text-ink-faint">
            <span className="inline-block h-3 w-0 border-l border-dashed border-ink-soft" aria-hidden /> market avg {marketAvg.toFixed(1)}★
          </p>
        )}
      </div>

      <div className="space-y-1.5">
        {rows.map((p, i) => (
          <div key={i} className="flex items-center gap-2.5">
            <span className={`w-5 shrink-0 text-right text-[11px] font-semibold tabular-nums ${p.isTarget ? "text-brand-deep" : "text-ink-faint"}`}>
              {i + 1}
            </span>
            <span className={`w-28 shrink-0 truncate text-xs sm:w-40 ${p.isTarget ? "font-bold text-brand-deep" : "text-ink-soft"}`} title={p.name}>
              {p.name}{p.isTarget ? " (you)" : ""}
            </span>
            <div className="relative h-5 flex-1 rounded-full bg-surface-sunken">
              {/* market average line */}
              {marketAvg != null && (
                <span className="absolute top-0 h-5 w-px border-l border-dashed border-ink-soft/70" style={{ left: pct(marketAvg) }} aria-hidden />
              )}
              {/* the business's rating dot */}
              <span
                className={`absolute top-1/2 -translate-x-1/2 -translate-y-1/2 rounded-full ${p.isTarget ? "h-3.5 w-3.5 bg-brand-gradient shadow-brand ring-2 ring-white" : "h-2.5 w-2.5 bg-ink-faint/60"}`}
                style={{ left: pct(p.rating) }}
                aria-hidden
              />
            </div>
            <span className={`w-8 shrink-0 text-right text-xs tabular-nums ${p.isTarget ? "font-bold text-brand-deep" : "font-medium text-ink-soft"}`}>
              {p.rating.toFixed(1)}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}
