import Link from "next/link";
import type { FallingBehind, PriceWin } from "@/lib/fallingbehind";
import { FallingBehindFlags } from "@/components/FallingBehindFlags";
import { ActOnIt } from "@/components/ActOnIt";

/** Positive counterpart: staples the owner beats the market on — a promotable win. */
function PriceWins({ wins }: { wins: PriceWin[] }) {
  if (!wins.length) return null;
  const top = wins.slice(0, 5);
  const list = top.map((w) => `${w.item} (−${w.underPct}%)`).join(", ");
  return (
    <div className="mt-3 rounded-xl border-l-[3px] border-l-trust-direct bg-trust-direct/5 p-3">
      <div className="flex items-center gap-2">
        <span className="text-[11px] font-semibold uppercase tracking-wide text-trust-direct">💪 You win on price</span>
        <span className="font-display text-base font-extrabold text-ink">{top.length} staple{top.length === 1 ? "" : "s"} beat the market</span>
      </div>
      <p className="mt-1 text-sm text-ink-soft">You&apos;re the cheapest in your market on <span className="font-medium text-ink">{list}</span>{wins.length > top.length ? ` +${wins.length - top.length} more` : ""} — worth putting front-and-center.</p>
      <div className="mt-2">
        <ActOnIt
          kind="content"
          move={`Promote our price advantage: we beat the local market on ${top.map((w) => w.item).slice(0, 4).join(", ")}`}
          context={`Below-market on ${top.map((w) => `${w.item} by ${w.underPct}%`).join("; ")}`}
          label="Draft a price-lead post"
          small
        />
      </div>
    </div>
  );
}

/**
 * "You're falling behind" — the V2 defensive opportunity lane on Today. Shows the
 * moves several competitors are making that the owner isn't (trustworthy supply-side
 * signal), plus low-confidence "early signals" from recurring customer demand where
 * few rivals are seen. Server wrapper over the cached goals.fallingBehind pillar —
 * no LLM on the render path; the interactive flag list is a client child.
 */
export function FallingBehindCard({ data }: { data: FallingBehind }) {
  if (!data || data.empty || (!data.flags?.length && !data.priceWins?.length)) return null;
  return (
    <section className="card">
      <div className="mb-3 flex items-center justify-between gap-3">
        <h2 className="flex items-center gap-2 text-sm font-semibold text-ink">
          <span className="grid h-7 w-7 place-items-center rounded-lg bg-brand-soft text-brand">🛰️</span>
          Where you stand vs your market
        </h2>
        <Link href="/competitors" className="shrink-0 text-xs font-semibold text-brand-deep hover:underline">See competitors →</Link>
      </div>

      {data.flags.length > 0 && (
        <>
          <p className="mb-3 text-xs text-ink-faint">Moves several competitors are making that you&apos;re not — from what we&apos;ve observed across your market.</p>
          <FallingBehindFlags flags={data.flags} />
        </>
      )}

      {data.priceWins?.length > 0 && <PriceWins wins={data.priceWins} />}

      {data.qualityBars.length > 0 && (
        <p className="mt-3 border-t border-line/60 pt-2 text-[11px] text-ink-faint">
          Also heard across the market (quality bars to hold, not openings): {data.qualityBars.slice(0, 6).join(" · ")}.
        </p>
      )}
    </section>
  );
}
