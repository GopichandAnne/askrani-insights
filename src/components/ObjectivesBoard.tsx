"use client";

import { DraftButton } from "@/components/DraftButton";
import type { ObjectivesReport, Objective, Horizon } from "@/lib/objectives";

/** The interactive "your plan to stand out" board — daily/weekly/monthly
 *  milestones, auto-graded from data, with a progress journey and a one-tap
 *  "Do it with Rani" (drafts the post/message/plan) on each open milestone. */

interface Standing { you: number | null; rank: number | null; total: number; leader: string | null; leaderScore: number | null }

const HORIZONS: { key: Horizon; label: string; note: string }[] = [
  { key: "daily", label: "Daily milestones", note: "small, repeatable wins" },
  { key: "weekly", label: "Weekly milestones", note: "" },
  { key: "monthly", label: "Monthly milestones", note: "the bigger bets" },
];

const UNIT: Record<string, string> = {
  rating: "★", reviews: "reviews", posts7d: "posts/wk", followers: "followers",
  findabilityScore: "findability", findabilityTop3: "top-3 terms", aiScore: "AI score", pricesPublished: "priced items",
};
const targetLabel = (o: Objective): string | null =>
  o.metric === "manual" ? null : (o.op === "plus" ? `+${o.target} ${UNIT[o.metric] ?? ""}`.trim() : `reach ${o.target} ${UNIT[o.metric] ?? ""}`.trim());

function Ring({ done, total }: { done: number; total: number }) {
  const pct = total ? done / total : 0;
  const R = 20, C = 2 * Math.PI * R;
  return (
    <svg width="52" height="52" viewBox="0 0 52 52" className="shrink-0">
      <circle cx="26" cy="26" r={R} fill="none" stroke="var(--line, #e5e7eb)" strokeWidth="5" />
      <circle cx="26" cy="26" r={R} fill="none" stroke="var(--teal, #14b8a6)" strokeWidth="5" strokeLinecap="round"
        strokeDasharray={C} strokeDashoffset={C * (1 - pct)} transform="rotate(-90 26 26)" style={{ transition: "stroke-dashoffset .6s ease" }} />
      <text x="26" y="30" textAnchor="middle" className="fill-ink text-[13px] font-bold">{done}/{total}</text>
    </svg>
  );
}

export function ObjectivesBoard({ report, standing, businessName, vertical }: { report: ObjectivesReport; standing: Standing; businessName: string; vertical: string }) {
  const items = report.items ?? [];
  const done = items.filter((o) => o.status === "done").length;
  const you = standing.you ?? 0;
  const leader = standing.leaderScore ?? 100;
  const toLeadPct = leader > 0 ? Math.min(100, Math.round((you / leader) * 100)) : 0;
  const gap = standing.leaderScore != null && standing.you != null ? Math.max(0, standing.leaderScore - standing.you) : null;

  return (
    <div className="space-y-6">
      {/* ── standing hero: milestones → climbing the market ── */}
      <section className="glass-strong relative overflow-hidden rounded-3xl p-6">
        <div className="pointer-events-none absolute inset-0 bg-brand-mesh opacity-[0.08]" aria-hidden />
        <div className="relative flex flex-wrap items-center justify-between gap-4">
          <div>
            <p className="text-xs font-semibold uppercase tracking-wide text-brand-deep">Where you stand</p>
            <p className="mt-1 font-display text-3xl font-extrabold">
              Position score {standing.you ?? "—"}<span className="text-lg text-ink-faint">/100</span>
              {standing.rank ? <span className="ml-2 text-lg font-bold text-ink-soft">· #{standing.rank} of {standing.total}</span> : null}
            </p>
            <p className="mt-1 text-sm text-ink-soft">
              {gap != null && gap > 0 && standing.leader
                ? <>You&apos;re <b>{gap} points</b> from the leader ({standing.leader}). Complete your milestones to close the gap.</>
                : standing.rank === 1 ? <>You&apos;re leading your market — keep the milestones going to hold it.</> : <>Complete your milestones to climb your market.</>}
            </p>
          </div>
          <div className="text-right">
            <p className="font-display text-2xl font-extrabold text-brand-deep">{done}/{items.length}</p>
            <p className="text-xs text-ink-faint">milestones done now{report.completedTotal ? ` · ${report.completedTotal} all-time` : ""}</p>
          </div>
        </div>
        {/* progress toward the leader */}
        <div className="relative mt-4">
          <div className="h-2.5 w-full overflow-hidden rounded-full bg-white/50">
            <div className="h-full rounded-full bg-brand-gradient transition-all duration-700" style={{ width: `${toLeadPct}%` }} />
          </div>
          <div className="mt-1 flex justify-between text-[11px] text-ink-faint"><span>You</span><span>Market leader{standing.leader ? ` · ${standing.leader}` : ""}</span></div>
        </div>
      </section>

      {/* ── the milestones, by horizon ── */}
      {HORIZONS.map(({ key, label, note }) => {
        const group = items.filter((o) => o.horizon === key);
        if (!group.length) return null;
        const gDone = group.filter((o) => o.status === "done").length;
        return (
          <section key={key} className="card">
            <div className="mb-3 flex items-center gap-3">
              <Ring done={gDone} total={group.length} />
              <div>
                <h2 className="font-semibold">{label}</h2>
                <p className="text-xs text-ink-faint">{note || "auto-checked from your data as you improve"}</p>
              </div>
            </div>
            <ul className="space-y-2">
              {group.map((o) => {
                const doneY = o.status === "done";
                const tl = targetLabel(o);
                return (
                  <li key={o.id} className="flex flex-wrap items-start gap-2.5 rounded-2xl bg-white/50 p-3">
                    <span className={`mt-0.5 grid h-5 w-5 shrink-0 place-items-center rounded-full text-[11px] font-bold ${doneY ? "bg-trust-direct text-white" : "border-2 border-line text-transparent"}`} aria-hidden>✓</span>
                    <div className="min-w-0 flex-1">
                      <p className={`text-sm font-medium ${doneY ? "text-ink-faint line-through" : "text-ink"}`}>{o.title}</p>
                      {o.why && <p className="mt-0.5 text-xs text-ink-faint">{o.why}</p>}
                      {o.evidence && (
                        <p className="mt-1.5 rounded-lg border-l-2 border-brand-soft bg-white/40 px-2 py-1 text-[11px] leading-relaxed text-ink-soft">
                          <span className="font-semibold text-brand-deep">From your data — </span>{o.evidence}
                        </p>
                      )}
                    </div>
                    <div className="flex shrink-0 items-center gap-2 self-center">
                      {tl
                        ? <span className={`chip text-[11px] ${doneY ? "bg-trust-direct/10 text-trust-direct" : "bg-brand-soft text-brand-deep"}`}>{doneY ? "✓ hit" : tl}</span>
                        : <span className="chip bg-surface-sunken text-[11px] text-ink-faint" title="No data signal — track this one yourself">you track</span>}
                      {!doneY && <DraftButton move={o.title} context={`Business: ${businessName} (${vertical}). Goal: ${o.title}. Why: ${o.why}`} />}
                    </div>
                  </li>
                );
              })}
            </ul>
          </section>
        );
      })}

      <p className="text-center text-xs text-ink-faint">Milestones are set from your gaps vs the market leader, competitors&apos; moves, upcoming occasions and unmet demand — and tick off automatically as your data improves.</p>
    </div>
  );
}
