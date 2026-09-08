import Link from "next/link";
import type { FallingBehind, FallingBehindFlag } from "@/lib/fallingbehind";
import { ActOnIt } from "@/components/ActOnIt";

/**
 * "You're falling behind" — the V2 defensive opportunity lane on Today. Shows the
 * moves several competitors are making that the owner isn't (trustworthy supply-side
 * signal), plus low-confidence "early signals" from recurring customer demand where
 * few rivals are seen. Pure presentation of the cached goals.fallingBehind pillar —
 * no LLM on the render path. Honest by construction: demand-gap items are labelled
 * low-confidence (our competitor coverage is promo-events-only, so "no rivals" may
 * be a blind spot), and the strongest flags are the supply-side ones.
 */

const META: Record<FallingBehindFlag["tag"], { icon: string; label: string; cls: string }> = {
  demand_moving: { icon: "🎯", label: "Rising · rivals moving", cls: "border-l-coral bg-coral/5" },
  behind: { icon: "🔻", label: "Falling behind", cls: "border-l-brand bg-brand-soft/40" },
  demand_gap: { icon: "🌱", label: "Early signal · low confidence", cls: "border-l-line bg-surface-sunken/60" },
};

function line(f: FallingBehindFlag): string {
  if (f.tag === "behind") return `${f.rivalCount} of your competitors run this — you don't.`;
  if (f.tag === "demand_moving") return `Customers keep asking, and ${f.rivalCount} rival${f.rivalCount === 1 ? " has" : "s have"} started — you haven't.`;
  return `Customers keep asking for this and few rivals offer it — worth a low-cost test.`;
}

export function FallingBehindCard({ data }: { data: FallingBehind }) {
  if (!data || data.empty || !data.flags?.length) return null;
  return (
    <section className="card">
      <div className="mb-3 flex items-center justify-between gap-3">
        <h2 className="flex items-center gap-2 text-sm font-semibold text-ink">
          <span className="grid h-7 w-7 place-items-center rounded-lg bg-brand-soft text-brand">🛰️</span>
          Where you&apos;re falling behind
        </h2>
        <Link href="/competitors" className="shrink-0 text-xs font-semibold text-brand-deep hover:underline">See competitors →</Link>
      </div>
      <p className="mb-3 text-xs text-ink-faint">Moves several competitors are making that you&apos;re not — from what we&apos;ve observed across your market.</p>

      <div className="space-y-2.5">
        {data.flags.map((f, i) => {
          const m = META[f.tag];
          return (
            <div key={i} className={`rounded-xl border-l-[3px] ${m.cls} p-3`}>
              <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                <span className="text-[11px] font-semibold uppercase tracking-wide text-ink-soft">{m.icon} {m.label}</span>
                <span className="font-display text-base font-extrabold text-ink">{f.concept}</span>
              </div>
              <p className="mt-1 text-sm text-ink-soft">{line(f)}</p>
              {f.rivals.length > 0 && (
                <div className="mt-1.5 flex flex-wrap gap-1.5">
                  {f.rivals.slice(0, 4).map((r) => (
                    <span key={r} className="chip bg-surface-sunken text-ink-faint">{r}</span>
                  ))}
                </div>
              )}
              {f.tag === "demand_gap" && f.demandExample && (
                <p className="mt-1 text-xs italic text-ink-faint">“{f.demandExample}”</p>
              )}
              <div className="mt-2">
                <ActOnIt
                  kind="content"
                  move={f.tag === "behind"
                    ? `Match what competitors are doing: ${f.concept}`
                    : `Test ${f.concept} — customers are asking and few rivals offer it`}
                  context={f.evidence || f.demandExample}
                  label={f.tag === "demand_gap" ? "Draft a low-cost test" : "Draft a response"}
                  small
                />
              </div>
            </div>
          );
        })}
      </div>

      {data.qualityBars.length > 0 && (
        <p className="mt-3 border-t border-line/60 pt-2 text-[11px] text-ink-faint">
          Also heard across the market (quality bars to hold, not openings): {data.qualityBars.slice(0, 6).join(" · ")}.
        </p>
      )}
    </section>
  );
}
