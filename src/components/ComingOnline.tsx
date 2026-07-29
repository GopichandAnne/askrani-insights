import Link from "next/link";

/**
 * Placeholder for screens that populate once continuous monitoring + Supabase
 * persistence are wired (next increment). Kept honest: says what will fill it.
 */
export function ComingOnline({
  title,
  blurb,
  populatedBy,
}: {
  title: string;
  blurb: string;
  populatedBy: string;
}) {
  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
      <p className="max-w-2xl text-ink-soft">{blurb}</p>
      <div className="rounded-xl border border-dashed border-line bg-surface p-6 text-sm text-ink-soft">
        <p>
          This screen fills from persisted observations. {populatedBy}
        </p>
        <Link href="/onboarding" className="mt-3 inline-flex text-brand hover:underline">
          Run a live market analysis now →
        </Link>
      </div>
    </div>
  );
}
