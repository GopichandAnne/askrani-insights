import Link from "next/link";
import type { ObjectivesReport, Objective, Horizon } from "@/lib/objectives";

/** Proactive, self-grading action plan — daily/weekly/monthly objectives that
 *  target where the business lags, auto-checked off from data (no self-reporting).
 *  Manual items (no measurable signal) are shown as owner-tracked. */
const HORIZONS: { key: Horizon; label: string; note: string }[] = [
  { key: "daily", label: "Today", note: "quick wins" },
  { key: "weekly", label: "This week", note: "" },
  { key: "monthly", label: "This month", note: "bigger bets" },
];

const targetLabel = (o: Objective): string | null => {
  if (o.metric === "manual") return null;
  const unit: Record<string, string> = {
    rating: "★", reviews: "reviews", posts7d: "posts/wk", followers: "followers",
    findabilityScore: "findability", findabilityTop3: "top-3 terms", aiScore: "AI score", pricesPublished: "priced items",
  };
  return o.op === "plus" ? `+${o.target} ${unit[o.metric] ?? ""}`.trim() : `reach ${o.target} ${unit[o.metric] ?? ""}`.trim();
};

export function ObjectivesCard({ report }: { report: ObjectivesReport }) {
  const items = report.items ?? [];
  if (!items.length) return null;
  const done = items.filter((o) => o.status === "done").length;

  return (
    <section className="card">
      <div className="mb-1 flex flex-wrap items-center justify-between gap-2">
        <h2 className="flex items-center gap-2 font-semibold">🎯 Your objectives <span className="text-xs font-normal text-ink-faint">— auto-tracked from your data</span></h2>
        <Link href="/plan" className="text-xs font-medium text-brand hover:underline">Open your plan →</Link>
      </div>
      <p className="text-xs text-ink-faint">{done}/{items.length} done{report.completedTotal ? ` · ${report.completedTotal} completed all-time` : ""}</p>

      <div className="mt-3 space-y-4">
        {HORIZONS.map(({ key, label, note }) => {
          const group = items.filter((o) => o.horizon === key);
          if (!group.length) return null;
          return (
            <div key={key}>
              <p className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-brand-deep">{label}{note ? <span className="ml-1 font-normal text-ink-faint">· {note}</span> : null}</p>
              <ul className="space-y-1.5">
                {group.map((o) => {
                  const doneY = o.status === "done";
                  const tl = targetLabel(o);
                  return (
                    <li key={o.id} className="flex items-start gap-2.5 rounded-2xl bg-white/50 p-2.5">
                      <span className={`mt-0.5 grid h-5 w-5 shrink-0 place-items-center rounded-full text-[11px] font-bold ${doneY ? "bg-trust-direct text-white" : "border-2 border-line text-transparent"}`} aria-hidden>✓</span>
                      <div className="min-w-0 flex-1">
                        <p className={`text-sm font-medium ${doneY ? "text-ink-faint line-through" : "text-ink"}`}>{o.title}</p>
                        {o.why && <p className="mt-0.5 text-xs text-ink-faint">{o.why}</p>}
                        {o.evidence && !doneY && <p className="mt-1 text-[11px] text-ink-soft"><span className="font-semibold text-brand-deep">From your data — </span>{o.evidence}</p>}
                      </div>
                      <span className="shrink-0 self-center">
                        {tl
                          ? <span className={`chip text-[11px] ${doneY ? "bg-trust-direct/10 text-trust-direct" : "bg-brand-soft text-brand-deep"}`}>{doneY ? "✓ hit" : tl}</span>
                          : <span className="chip bg-surface-sunken text-[11px] text-ink-faint" title="No data signal for this one — track it yourself">you track</span>}
                      </span>
                    </li>
                  );
                })}
              </ul>
            </div>
          );
        })}
      </div>
      <p className="mt-2 text-[11px] text-ink-faint">Objectives are set from your gaps vs the market leader, competitors&apos; moves, upcoming occasions and unmet demand — and checked off automatically as your data improves.</p>
    </section>
  );
}
