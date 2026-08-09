import type { MarketMemory as Memory, MarketEventRow } from "@/lib/panel";

/**
 * Surfaces the append-only market_event log — the artifacts the market has run
 * over time (deals, ad-moves, breakouts), preserved with dates. This is the
 * seasonal memory: it reads thin now (one month) and becomes a year-over-year
 * playbook as history accrues.
 */

const KIND: Record<string, { icon: string; label: string; chip: string }> = {
  deal: { icon: "🏷️", label: "Deal", chip: "bg-coral/15 text-coral-dark" },
  ad_move: { icon: "📣", label: "Ad move", chip: "bg-brand-soft text-brand-deep" },
  breakout: { icon: "🚀", label: "Breakout", chip: "bg-brand-soft text-brand-deep" },
};
const fmtDate = (d: string) => new Date(d + "T00:00:00").toLocaleDateString(undefined, { month: "short", day: "numeric" });

export function MarketMemory({ memory }: { memory: Memory }) {
  if (!memory.total) return null;
  const { byKind, recent, dealsByMonth, sinceDate } = memory;
  const maxMonth = Math.max(1, ...dealsByMonth.map((m) => m.count));

  return (
    <section className="card">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="flex items-center gap-2 font-semibold">
          <span className="grid h-7 w-7 place-items-center rounded-lg bg-brand-gradient text-white shadow-brand">🗓️</span>
          Market memory — deals &amp; moves your rivals have run
        </h2>
        {sinceDate && <span className="text-[11px] text-ink-faint">preserved since {fmtDate(sinceDate)}</span>}
      </div>

      <div className="mt-3 flex flex-wrap gap-2">
        <Stat n={byKind.deal ?? 0} label="deals" />
        <Stat n={byKind.ad_move ?? 0} label="ad moves" />
        <Stat n={byKind.breakout ?? 0} label="breakouts" />
        <Stat n={byKind.demand ?? 0} label="demand signals" />
      </div>

      {/* seasonality: month bars once ≥2 months exist, else the honest note */}
      {dealsByMonth.length >= 2 ? (
        <div className="mt-4">
          <div className="text-[11px] font-semibold uppercase tracking-wide text-ink-faint">Deals seen by month</div>
          <div className="mt-2 flex items-end gap-2" style={{ height: 64 }}>
            {dealsByMonth.map((m) => (
              <div key={m.month} className="flex flex-1 flex-col items-center gap-1">
                <div className="w-full rounded-t bg-brand-gradient" style={{ height: `${Math.round((m.count / maxMonth) * 48) + 4}px` }} title={`${m.count} deals`} />
                <span className="text-[10px] text-ink-faint">{m.month.slice(5)}</span>
              </div>
            ))}
          </div>
        </div>
      ) : (
        <p className="mt-3 rounded-xl bg-surface-sunken px-3 py-2 text-xs text-ink-faint">
          Seasonal patterns build as months accrue — this becomes your Diwali / July-4th playbook (what worked, when) over the year.
        </p>
      )}

      {recent.length > 0 && (
        <div className="mt-4">
          <div className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-ink-faint">Recently preserved</div>
          <ul className="space-y-1.5">
            {recent.map((e, i) => <Row key={i} e={e} />)}
          </ul>
        </div>
      )}
    </section>
  );
}

function Row({ e }: { e: MarketEventRow }) {
  const k = KIND[e.kind] ?? { icon: "•", label: e.kind, chip: "bg-surface-sunken text-ink-soft" };
  const ran = e.lastSeen > e.firstSeen ? `${fmtDate(e.firstSeen)}–${fmtDate(e.lastSeen)}` : fmtDate(e.firstSeen);
  return (
    <li className="flex items-center gap-2.5 rounded-xl bg-white/45 px-3 py-2">
      <span className={`shrink-0 rounded-full px-1.5 py-0.5 text-[11px] ${k.chip}`} title={k.label}>{k.icon}</span>
      <span className="min-w-0 flex-1 truncate text-sm text-ink">
        {e.rival && <span className="font-semibold">{e.rival}: </span>}{e.title}
      </span>
      {e.url ? (
        <a href={e.url} target="_blank" rel="noreferrer" className="shrink-0 text-[11px] font-medium text-brand hover:underline" style={{ fontVariantNumeric: "tabular-nums" }}>{ran} ↗</a>
      ) : (
        <span className="shrink-0 text-[11px] text-ink-faint" style={{ fontVariantNumeric: "tabular-nums" }}>{ran}</span>
      )}
    </li>
  );
}

function Stat({ n, label }: { n: number; label: string }) {
  return (
    <span className="inline-flex items-baseline gap-1.5 rounded-full bg-white/70 px-3 py-1">
      <span className="text-sm font-bold text-brand-deep" style={{ fontVariantNumeric: "tabular-nums" }}>{n}</span>
      <span className="text-[11px] text-ink-faint">{label}</span>
    </span>
  );
}
