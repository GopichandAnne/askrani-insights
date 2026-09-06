import type { AlertLogEntry } from "@/lib/alerts";

/**
 * "Rani alerted you" strip on /brief — the in-app record of the real-time trigger
 * alerts that were pushed (email/WhatsApp), so an owner who missed the push still
 * sees what changed and when. Pure display, reads goals.alertLog. Renders nothing
 * when there's no alert history.
 */
function rel(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  if (isNaN(ms)) return "";
  const m = Math.floor(ms / 60_000);
  if (m < 60) return `${Math.max(1, m)}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

export function RecentAlerts({ log }: { log: AlertLogEntry[] }) {
  const recent = (log ?? []).filter((e) => e?.headline && e?.at).slice(0, 4);
  if (!recent.length) return null;
  return (
    <div className="rounded-2xl border border-coral/30 bg-coral/5 p-3.5">
      <div className="mb-2 flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-coral-dark">
        <span aria-hidden>⚡</span> Rani alerted you
      </div>
      <ul className="space-y-1.5">
        {recent.map((e, i) => (
          <li key={i} className="flex items-baseline justify-between gap-3 text-sm">
            <span className="text-ink">{e.headline}</span>
            <span className="shrink-0 text-[11px] text-ink-faint">
              {rel(e.at)}{e.channels?.length ? ` · ${e.channels.join(", ")}` : ""}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}
