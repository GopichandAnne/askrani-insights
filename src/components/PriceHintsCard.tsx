import type { PriceHintsReport } from "@/lib/pricehints";

/** "What customers say they paid" — real price hints mined from reviews across the
 *  market. Honest by construction: a range with a mention count + the actual quote,
 *  never a fabricated exact fee. The answer to "how do I get a hint into competitor
 *  pricing" for verticals (dental etc.) that don't publish a price list. */
const SENTIMENT: Record<string, { chip: string; label: string }> = {
  value: { chip: "bg-trust-direct/10 text-trust-direct", label: "good value" },
  steep: { chip: "bg-coral/10 text-coral", label: "felt pricey" },
  neutral: { chip: "bg-surface-sunken text-ink-faint", label: "" },
};

export function PriceHintsCard({ report }: { report: PriceHintsReport }) {
  if (!report || report.empty || !report.byItem?.length) return null;
  const examples = (report.hints ?? []).filter((h) => !h.isYou).slice(0, 6);

  return (
    <section className="card">
      <h2 className="flex flex-wrap items-center gap-2 font-semibold">
        💬 Prices seen around your market
        <span className="text-xs font-normal text-ink-faint">— mined from reviews &amp; posts across your competitors</span>
      </h2>
      {report.summary && <p className="mt-1 max-w-3xl text-sm text-ink-soft">{report.summary}</p>}

      {/* per-offering market range */}
      <div className="mt-3 grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
        {report.byItem.slice(0, 9).map((b) => (
          <div key={b.item} className="rounded-2xl bg-white/50 p-3">
            <p className="text-sm font-semibold capitalize text-ink">{b.item}</p>
            <p className="mt-0.5 font-display text-lg font-extrabold text-brand-deep">
              {b.low === b.high ? `$${b.low}` : `$${b.low}–$${b.high}`}
              {b.mentions > 1 && b.median !== b.low && b.median !== b.high ? <span className="ml-1 text-xs font-normal text-ink-faint">· typ. ${b.median}</span> : null}
            </p>
            <p className="text-[11px] text-ink-faint">{b.mentions} mention{b.mentions === 1 ? "" : "s"}{b.businesses > 1 ? ` · ${b.businesses} places` : ""}</p>
          </div>
        ))}
      </div>

      {/* a few real quotes so it's transparent, not a black box */}
      {examples.length > 0 && (
        <div className="mt-3 space-y-1.5">
          <p className="text-xs font-semibold uppercase tracking-wide text-brand-deep">Where we saw them</p>
          {examples.map((h, i) => {
            const s = SENTIMENT[h.sentiment] ?? SENTIMENT.neutral;
            return (
              <div key={i} className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 rounded-xl bg-white/40 px-3 py-2 text-sm">
                <span className="font-semibold text-ink">${h.amount}</span>
                <span className="capitalize text-ink-soft">{h.item}</span>
                <span className="text-xs text-ink-faint">· {h.business} ({h.source})</span>
                {s.label && <span className={`chip text-[10px] ${s.chip}`}>{s.label}</span>}
              </div>
            );
          })}
        </div>
      )}
      <p className="mt-2 text-[11px] text-ink-faint">Hints gathered from prices mentioned in reviews &amp; posts — a range, not exact fees (real prices vary by case and insurance).</p>
    </section>
  );
}
