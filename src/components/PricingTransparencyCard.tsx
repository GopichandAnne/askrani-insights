import type { PriceAnchorsReport, ClinicType } from "@/lib/priceanchors";

/** Pricing transparency intel (dental): who in the market publishes real prices vs
 *  keeps them off their site. Most private practices hide pricing, so this is both
 *  a competitive signal (opaque rivals = an opening to stand out) and the source of
 *  the real published anchors that sharpen the benchmark. */
const TYPE_LABEL: Record<ClinicType, string> = { chain: "chain", school: "dental school", public: "public clinic", independent: "independent" };
const money = (n: number) => `$${n.toLocaleString("en-US")}`;

export function PricingTransparencyCard({ report }: { report: PriceAnchorsReport }) {
  if (!report || report.empty) return null;
  const publishers = report.transparency.filter((t) => t.publishes);
  const opaque = report.transparency.filter((t) => !t.publishes && !t.isYou);

  return (
    <section className="card">
      <h2 className="flex flex-wrap items-center gap-2 font-semibold">
        🔍 Who publishes prices
        <span className="text-xs font-normal text-ink-faint">— pricing transparency across your market</span>
      </h2>
      {report.summary && <p className="mt-1 max-w-3xl text-sm text-ink-soft">{report.summary}</p>}

      {/* real published anchors, per procedure — the highest-confidence local prices */}
      {report.anchors.length > 0 && (
        <div className="mt-3">
          <p className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-brand-deep">Real posted prices nearby</p>
          <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
            {report.anchors.slice(0, 9).map((a) => (
              <div key={a.key} className="rounded-2xl bg-white/50 p-3">
                <p className="text-sm font-semibold capitalize text-ink">{a.label}</p>
                <p className="mt-0.5 font-display text-lg font-extrabold text-brand-deep">
                  {a.low === a.high ? money(a.low) : `${money(a.low)}–${money(a.high)}`}
                </p>
                <p className="truncate text-[11px] text-ink-faint">{a.prices[0]?.business}{a.prices.length > 1 ? ` +${a.prices.length - 1} more` : ""}</p>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* the transparency roster */}
      <div className="mt-3 grid gap-3 sm:grid-cols-2">
        <div className="rounded-2xl bg-trust-direct/5 p-3">
          <p className="text-xs font-semibold uppercase tracking-wide text-trust-direct">Publishes prices ({publishers.length})</p>
          <ul className="mt-1.5 space-y-1">
            {publishers.length ? publishers.map((t, i) => (
              <li key={i} className="flex items-center justify-between gap-2 text-sm">
                <span className="truncate">{t.isYou ? <b>You</b> : t.business} <span className="text-[11px] text-ink-faint">· {TYPE_LABEL[t.type]}</span></span>
                <span className="chip bg-trust-direct/10 text-[10px] text-trust-direct">{t.pricedItems} priced</span>
              </li>
            )) : <li className="text-sm text-ink-faint">No one in your market publishes prices — a clear opening.</li>}
          </ul>
        </div>
        <div className="rounded-2xl bg-surface-sunken p-3">
          <p className="text-xs font-semibold uppercase tracking-wide text-ink-faint">Pricing hidden ({opaque.length})</p>
          <ul className="mt-1.5 space-y-1">
            {opaque.slice(0, 8).map((t, i) => (
              <li key={i} className="truncate text-sm text-ink-soft">{t.business} <span className="text-[11px] text-ink-faint">· {TYPE_LABEL[t.type]}</span></li>
            ))}
            {!opaque.length && <li className="text-sm text-ink-faint">—</li>}
          </ul>
        </div>
      </div>
      <p className="mt-2 text-[11px] text-ink-faint">Most private practices keep pricing off their site — so a clear new-patient special or transparent fee menu is a simple way to stand out. Posted prices above are real anchors used to sharpen your area benchmark.</p>
    </section>
  );
}
