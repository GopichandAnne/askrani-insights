import type { InsuranceCompare } from "@/lib/insurance";

/** Insurance-acceptance comparison (dental) — who takes which plans across the
 *  market, the plans competitors accept that you don't advertise (a gap), and the
 *  ones only you take (a differentiator). "Does this dentist take my insurance?" is
 *  a top patient filter, so this is real, actionable positioning data. */
export function InsuranceCompareCard({ report }: { report: InsuranceCompare }) {
  if (!report || report.empty || !report.market?.length) return null;
  const total = report.businesses.length;

  return (
    <section className="card">
      <h2 className="flex flex-wrap items-center gap-2 font-semibold">
        🛡️ Insurance across your market
        <span className="text-xs font-normal text-ink-faint">— who accepts which plans</span>
      </h2>
      {report.summary && <p className="mt-1 max-w-3xl text-sm text-ink-soft">{report.summary}</p>}

      {/* gaps + differentiators — the actionable bit, up top */}
      {(report.youMissing.length > 0 || report.youUnique.length > 0) && (
        <div className="mt-3 grid gap-3 sm:grid-cols-2">
          {report.youMissing.length > 0 && (
            <div className="rounded-2xl bg-amber-400/10 p-3">
              <p className="text-xs font-semibold uppercase tracking-wide text-amber-700">Competitors take, you don&apos;t list</p>
              <div className="mt-1.5 flex flex-wrap gap-1.5">
                {report.youMissing.slice(0, 10).map((p) => <span key={p} className="chip bg-amber-400/15 text-[11px] text-amber-800">{p}</span>)}
              </div>
              <p className="mt-1.5 text-[11px] text-ink-faint">If you&apos;re in-network, add these to your site &amp; Google profile.</p>
            </div>
          )}
          {report.youUnique.length > 0 && (
            <div className="rounded-2xl bg-trust-direct/5 p-3">
              <p className="text-xs font-semibold uppercase tracking-wide text-trust-direct">Only you list</p>
              <div className="mt-1.5 flex flex-wrap gap-1.5">
                {report.youUnique.slice(0, 10).map((p) => <span key={p} className="chip bg-trust-direct/10 text-[11px] text-trust-direct">{p}</span>)}
              </div>
              <p className="mt-1.5 text-[11px] text-ink-faint">A differentiator — promote it to those patients.</p>
            </div>
          )}
        </div>
      )}

      {/* per-payer market coverage */}
      <div className="mt-3 overflow-x-auto">
        <table className="w-full min-w-[420px] border-collapse text-sm">
          <thead>
            <tr className="border-b border-line text-left text-xs uppercase tracking-wide text-ink-faint">
              <th className="py-2 pr-3 font-semibold">Plan</th>
              <th className="py-2 pr-3 font-semibold">You</th>
              <th className="py-2 font-semibold">Practices accepting</th>
            </tr>
          </thead>
          <tbody>
            {report.market.slice(0, 16).map((r) => (
              <tr key={r.payer} className="border-b border-line/50">
                <td className="py-2 pr-3 font-medium text-ink">{r.payer}</td>
                <td className="py-2 pr-3">{r.youAccept ? <span className="text-trust-direct">✓</span> : <span className="text-ink-faint">—</span>}</td>
                <td className="py-2 text-ink-soft">
                  <span className="inline-flex items-center gap-2">
                    <span className="tabular-nums">{r.count}{total ? `/${total}` : ""}</span>
                    <span className="h-1.5 w-24 overflow-hidden rounded-full bg-surface-sunken"><span className="block h-full rounded-full bg-brand-gradient" style={{ width: `${total ? Math.round((r.count / total) * 100) : 0}%` }} /></span>
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="mt-2 text-[11px] text-ink-faint">Read from what each practice publishes on its site. Insurance acceptance is a top patient filter — completeness matters more than price for many bookings.</p>
    </section>
  );
}
