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

/** The official Ask Rani mascot mark — the canonical free-standing robot,
 *  identical to the marketing site (askrani.ai). */
export function RaniMark({ size = 28 }: { size?: number }) {
  return (
    <svg width={size} height={Math.round(size * 1.2)} viewBox="0 0 100 120" aria-hidden className="shrink-0">
      <line x1="38" y1="22" x2="33" y2="12" stroke="#94A3B8" strokeWidth="2.5" strokeLinecap="round" />
      <circle cx="32" cy="10" r="4.5" fill="#14B8A6" />
      <line x1="62" y1="22" x2="67" y2="12" stroke="#94A3B8" strokeWidth="2.5" strokeLinecap="round" />
      <circle cx="68" cy="10" r="4.5" fill="#FB923C" />
      <rect x="25" y="20" width="50" height="40" rx="18" fill="#f0fdfa" stroke="#99f6e4" strokeWidth="1.5" />
      <circle cx="42" cy="38" r="6" fill="white" stroke="#ccfbf1" strokeWidth="1" />
      <circle cx="58" cy="38" r="6" fill="white" stroke="#ccfbf1" strokeWidth="1" />
      <circle cx="42.5" cy="38.5" r="3.5" fill="#14B8A6" />
      <circle cx="58.5" cy="38.5" r="3.5" fill="#14B8A6" />
      <circle cx="41" cy="36.5" r="1.5" fill="white" opacity="0.8" />
      <circle cx="57" cy="36.5" r="1.5" fill="white" opacity="0.8" />
      <path d="M44 52 Q50 57 56 52" stroke="#14B8A6" strokeWidth="1.5" fill="none" strokeLinecap="round" />
      <rect x="35" y="65" width="30" height="32" rx="12" fill="#14B8A6" />
      <circle cx="45" cy="78" r="1.5" fill="white" opacity="0.3" />
      <circle cx="50" cy="78" r="1.5" fill="white" opacity="0.3" />
      <circle cx="55" cy="78" r="1.5" fill="white" opacity="0.3" />
    </svg>
  );
}

/** The wordmark — Rani mascot + "Ask Rani" in Playfair italic + differentiator. */
export function RaniWordmark({ compact = false }: { compact?: boolean }) {
  return (
    <span className="flex items-center gap-2">
      <RaniMark size={30} />
      <span className="font-display text-xl font-extrabold italic text-brand-deep">Ask Rani</span>
      {!compact && (
        <span className="rounded-full bg-brand-soft px-2 py-0.5 text-[11px] font-semibold not-italic text-brand-deep">
          Insights
        </span>
      )}
    </span>
  );
}
