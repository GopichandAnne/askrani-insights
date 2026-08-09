/**
 * The Emerging / Rising / Fading columns used by both the review pulse (You) and
 * the social pulse (Content) — one shared component so the "what's changing"
 * visual reads identically everywhere.
 */
export interface PulseColumn { title: string; tone: string; items: string[]; empty: string }

export function PulseColumns({ columns }: { columns: PulseColumn[] }) {
  return (
    <div className="mt-3 grid gap-3 sm:grid-cols-3">
      {columns.map((c, i) => (
        <div key={i} className="rounded-2xl bg-white/55 p-3">
          <div className={`text-[11px] font-semibold uppercase tracking-wide ${c.tone}`}>{c.title}</div>
          {c.items.length ? (
            <ul className="mt-1 space-y-0.5">
              {c.items.slice(0, 4).map((t, j) => <li key={j} className="text-sm text-ink">{t}</li>)}
            </ul>
          ) : (
            <p className="mt-1 text-xs text-ink-faint">{c.empty}</p>
          )}
        </div>
      ))}
    </div>
  );
}
