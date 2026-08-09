import Link from "next/link";
import type { Digest, DigestItem } from "@/lib/digest";
import { ActOnIt } from "@/components/ActOnIt";

/**
 * The digest feed — "what changed and what to do," shown at the top of Home so
 * the owner sees the few things worth their attention without hunting through
 * pillars. Every item that can be acted on carries a one-tap Act button. This is
 * the same content that gets pushed to their inbox each week (see notify.ts).
 *
 * Hierarchy: the top few (alerts sort first) render as full cards with a severity
 * stripe; the tail collapses into a compact "Show N more" so the feed stays short
 * on mobile. The headline is the single count — "new" is a quiet qualifier, not a
 * competing badge.
 */

const PRIMARY = 3; // full cards; the rest collapse

const SEV: Record<DigestItem["severity"], { ring: string; chip: string; stripe: string }> = {
  alert: { ring: "border-coral/40", chip: "bg-coral/15 text-coral-dark", stripe: "border-l-4 border-l-coral" },
  opportunity: { ring: "border-brand/30", chip: "bg-brand-soft text-brand-deep", stripe: "border-l-4 border-l-brand/60" },
  fyi: { ring: "border-line", chip: "bg-surface-sunken text-ink-soft", stripe: "" },
};

function FullItem({ it }: { it: DigestItem }) {
  return (
    <li className={`rounded-2xl border bg-white/50 p-3.5 ${SEV[it.severity].ring} ${SEV[it.severity].stripe}`}>
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
  );
}

function CompactItem({ it }: { it: DigestItem }) {
  return (
    <li className="flex items-center gap-2.5 rounded-xl bg-white/40 px-3 py-2">
      <span className={`shrink-0 rounded-full px-1.5 py-0.5 text-[11px] ${SEV[it.severity].chip}`} title={it.pillar}>{it.icon}</span>
      <span className="min-w-0 flex-1 truncate text-sm text-ink">{it.title}</span>
      {it.act ? (
        <ActOnIt kind={it.act.kind} move={it.act.move} context={it.act.context} small />
      ) : it.href ? (
        <Link href={it.href} className="shrink-0 text-[11px] font-medium text-brand hover:underline">Details →</Link>
      ) : null}
    </li>
  );
}

export function DigestFeed({ digest }: { digest: Digest }) {
  if (!digest.items.length) return null;
  const primary = digest.items.slice(0, PRIMARY);
  const rest = digest.items.slice(PRIMARY);

  return (
    <section className="glass-strong rounded-3xl p-5 sm:p-6">
      <div>
        <p className="text-xs font-semibold uppercase tracking-wide text-brand-deep">
          This week · for you{digest.newCount > 0 && <span className="text-ink-faint"> · {digest.newCount} new</span>}
        </p>
        <h2 className="mt-0.5 font-display text-xl font-extrabold tracking-tight sm:text-2xl">{digest.headline}</h2>
      </div>

      <ul className="mt-4 space-y-2.5">
        {primary.map((it) => <FullItem key={it.id} it={it} />)}
      </ul>

      {rest.length > 0 && (
        <details className="mt-2.5">
          <summary className="inline-flex cursor-pointer list-none items-center gap-1 rounded-xl px-3 py-2 text-xs font-semibold text-brand-deep hover:bg-brand-soft/60">
            Show {rest.length} more <span aria-hidden>›</span>
          </summary>
          <ul className="mt-2 space-y-1.5">
            {rest.map((it) => <CompactItem key={it.id} it={it} />)}
          </ul>
        </details>
      )}
    </section>
  );
}
