import type { DentalBenchmark } from "@/lib/dentalbenchmark";

/** "Typical procedure prices near you" — a ballpark per dental procedure for the
 *  practice's area, from a standardized-code benchmark, overlaid with any real
 *  local price signal we've mined. Needs NO owner fee import — the same estimate
 *  applies to the owner and every competitor. Honest by construction: ranges, and
 *  local scraped signal shown separately when we have it. */
const money = (n: number) => `$${n.toLocaleString("en-US")}`;

export function DentalBenchmarkCard({ benchmark }: { benchmark: DentalBenchmark }) {
  if (!benchmark?.rows?.length) return null;
  const withLocal = benchmark.rows.filter((r) => r.localLow != null).length;

  return (
    <section className="card">
      <h2 className="flex flex-wrap items-center gap-2 font-semibold">
        🦷 Typical procedure prices{benchmark.region !== "your area" ? ` in ${benchmark.region}` : " near you"}
        <span className="text-xs font-normal text-ink-faint">— a ballpark per procedure, no fee sheet needed</span>
      </h2>
      <p className="mt-1 max-w-3xl text-sm text-ink-soft">
        What a patient would ballpark for each procedure in your area — the same estimate applies to you and your competitors.
        {withLocal > 0 && <> We&apos;ve also seen <b>{withLocal}</b> of these priced locally (shown in teal).</>}
      </p>

      <div className="mt-3 overflow-x-auto">
        <table className="w-full min-w-[520px] border-collapse text-sm">
          <thead>
            <tr className="border-b border-line text-left text-xs uppercase tracking-wide text-ink-faint">
              <th className="py-2 pr-3 font-semibold">Procedure</th>
              <th className="py-2 pr-3 font-semibold">Typical in your area</th>
              <th className="py-2 font-semibold">Seen locally</th>
            </tr>
          </thead>
          <tbody>
            {benchmark.rows.map((r) => (
              <tr key={r.key} className="border-b border-line/50">
                <td className="py-2 pr-3">
                  <span className="font-medium text-ink">{r.label}</span>
                  {r.cdt && <span className="ml-1.5 text-[10px] text-ink-faint">{r.cdt}</span>}
                </td>
                <td className="py-2 pr-3 tabular-nums text-ink-soft">
                  {r.areaLow === r.areaHigh ? money(r.areaLow) : `${money(r.areaLow)}–${money(r.areaHigh)}`}
                </td>
                <td className="py-2 tabular-nums">
                  {r.localLow != null ? (
                    <span className="font-semibold text-brand-deep">
                      {r.localLow === r.localHigh ? money(r.localLow) : `${money(r.localLow)}–${money(r.localHigh!)}`}
                      <span className="ml-1 text-[11px] font-normal text-ink-faint">
                        {r.localWhere ? `${r.localWhere}` : `${r.localMentions}×`}
                        {r.localSource === "published"
                          ? <span className="ml-1 rounded bg-trust-direct/10 px-1 text-[10px] text-trust-direct">posted</span>
                          : <span className="ml-1 rounded bg-surface-sunken px-1 text-[10px] text-ink-faint">mentioned</span>}
                      </span>
                    </span>
                  ) : (
                    <span className="text-ink-faint">—</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="mt-2 text-[11px] text-ink-faint">{benchmark.note}</p>
    </section>
  );
}
