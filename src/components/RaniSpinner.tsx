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

/** The official Ask Rani mascot mark (from the platform's icon.svg). */
export function RaniMark({ size = 28 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 100 100" aria-hidden className="shrink-0">
      <defs>
        <linearGradient id="raniG" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#14B8A6" />
          <stop offset="1" stopColor="#0D9488" />
        </linearGradient>
      </defs>
      <rect width="100" height="100" rx="24" fill="url(#raniG)" />
      <line x1="40" y1="34" x2="36" y2="26" stroke="#fff" strokeWidth="3" strokeLinecap="round" opacity="0.9" />
      <line x1="60" y1="34" x2="64" y2="26" stroke="#fff" strokeWidth="3" strokeLinecap="round" opacity="0.9" />
      <circle cx="35" cy="23" r="5" fill="#5EEAD4" />
      <circle cx="65" cy="23" r="5" fill="#FDBA74" />
      <rect x="26" y="33" width="48" height="38" rx="17" fill="#fff" />
      <circle cx="42" cy="50" r="6.5" fill="#14B8A6" />
      <circle cx="58" cy="50" r="6.5" fill="#14B8A6" />
      <circle cx="40" cy="47.5" r="2" fill="#fff" opacity="0.9" />
      <circle cx="56" cy="47.5" r="2" fill="#fff" opacity="0.9" />
      <path d="M43 61 Q50 67 57 61" stroke="#14B8A6" strokeWidth="3" fill="none" strokeLinecap="round" />
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
