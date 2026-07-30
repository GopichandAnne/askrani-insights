/**
 * The Ask Rani loading motif — three bouncing teal dots — used everywhere we
 * wait (search, collection, page transitions). Matches the platform's typing
 * indicator exactly.
 */
export function RaniSpinner({ label }: { label?: string }) {
  return (
    <span className="inline-flex items-center gap-3 text-sm text-ink-faint">
      <span className="rani-dots" aria-hidden>
        <span />
        <span />
        <span />
      </span>
      {label ? <span>{label}</span> : null}
      <span className="sr-only">Loading…</span>
    </span>
  );
}

/** The wordmark — "Ask Rani" in Playfair italic + the product differentiator. */
export function RaniWordmark({ compact = false }: { compact?: boolean }) {
  return (
    <span className="flex items-center gap-2">
      <span
        className="grid h-7 w-7 place-items-center rounded-lg text-sm font-bold text-white"
        style={{ background: "var(--gradient-primary)", boxShadow: "var(--shadow-primary)" }}
        aria-hidden
      >
        R
      </span>
      <span className="font-display text-xl font-extrabold italic text-brand-deep">Ask Rani</span>
      {!compact && (
        <span className="rounded-full bg-brand-soft px-2 py-0.5 text-[11px] font-semibold not-italic text-brand-deep">
          Insights
        </span>
      )}
    </span>
  );
}
