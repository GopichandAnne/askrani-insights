import Link from "next/link";
import type { Digest, DigestItem } from "@/lib/digest";
import { ActOnIt } from "@/components/ActOnIt";

/**
 * The digest feed — "what changed and what to do," shown at the top of Home so
 * the owner sees the few things worth their attention without hunting through
 * pillars. Every item that can be acted on carries a one-tap Act button. This is
 * the same content that gets pushed to their inbox each week (see notify.ts).
 */

const SEV: Record<DigestItem["severity"], { ring: string; chip: string }> = {
  alert: { ring: "border-coral/40", chip: "bg-coral/15 text-coral-dark" },
  opportunity: { ring: "border-brand/30", chip: "bg-brand-soft text-brand-deep" },
  fyi: { ring: "border-white/40", chip: "bg-surface-sunken text-ink-soft" },
};

export function DigestFeed({ digest }: { digest: Digest }) {
  if (!digest.items.length) return null;
  return (
    <section className="glass-strong rounded-3xl p-5 sm:p-6">
      <div className="flex items-center justify-between gap-3">
        <div>
          <p className="text-xs font-semibold uppercase tracking-wide text-brand-deep">This week · for you</p>
          <h2 className="mt-0.5 font-display text-xl font-extrabold tracking-tight sm:text-2xl">{digest.headline}</h2>
        </div>
        {digest.newCount > 0 && (
          <span className="shrink-0 rounded-full bg-coral/15 px-2.5 py-1 text-[11px] font-semibold text-coral-dark">{digest.newCount} new</span>
        )}
      </div>

      <ul className="mt-4 space-y-2.5">
        {digest.items.map((it) => (
          <li key={it.id} className={`rounded-2xl border bg-white/50 p-3.5 ${SEV[it.severity].ring}`}>
            <div className="flex flex-wrap items-center gap-2">
              <span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${SEV[it.severity].chip}`}>
                {it.icon} {it.pillar}
              </span>
              {it.isNew && <span className="rounded-full bg-coral/15 px-2 py-0.5 text-[10px] font-semibold text-coral-dark">new</span>}
            </div>
            <p className="mt-1.5 text-sm font-semibold text-ink">{it.title}</p>
            <p className="mt-0.5 text-sm text-ink-soft">{it.detail}</p>
            <div className="mt-2 flex flex-wrap items-center gap-2">
              {it.act && <ActOnIt kind={it.act.kind} move={it.act.move} context={it.act.context} small />}
              {it.href && <Link href={it.href} className="text-[11px] font-medium text-brand hover:underline">See details →</Link>}
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}
