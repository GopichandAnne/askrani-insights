import Link from "next/link";
import type { FallingBehind } from "@/lib/fallingbehind";
import { FallingBehindFlags } from "@/components/FallingBehindFlags";

/**
 * "You're falling behind" — the V2 defensive opportunity lane on Today. Shows the
 * moves several competitors are making that the owner isn't (trustworthy supply-side
 * signal), plus low-confidence "early signals" from recurring customer demand where
 * few rivals are seen. Server wrapper over the cached goals.fallingBehind pillar —
 * no LLM on the render path; the interactive flag list is a client child.
 */
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

      <FallingBehindFlags flags={data.flags} />

      {data.qualityBars.length > 0 && (
        <p className="mt-3 border-t border-line/60 pt-2 text-[11px] text-ink-faint">
          Also heard across the market (quality bars to hold, not openings): {data.qualityBars.slice(0, 6).join(" · ")}.
        </p>
      )}
    </section>
  );
}
