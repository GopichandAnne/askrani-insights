/**
 * Findability score as a meter, not a bare number. A 0–100 track with the fill
 * colored by band (weak <40 · fair 40–59 · strong ≥60), the score called out with
 * an optional trend, and threshold ticks so the bands are legible. Reused on the
 * Findability page (headline), /you, and the Week home. Pure/server-rendered.
 */
function band(score: number): { fill: string; word: string; text: string } {
  if (score >= 60) return { fill: "bg-brand-gradient", word: "Strong", text: "text-brand-deep" };
  if (score >= 40) return { fill: "bg-brand/70", word: "Fair", text: "text-brand-deep" };
  return { fill: "bg-coral", word: "Weak", text: "text-coral-dark" };
}

export function FindabilityMeter({
  score, delta, sub, size = "md", showBand = true,
}: {
  score: number;
  delta?: number | null;      // positive = improved
  sub?: string;               // e.g. "top-3 for 4 of 12 searches"
  size?: "sm" | "md" | "lg";
  showBand?: boolean;
}) {
  const b = band(score);
  const pct = Math.max(2, Math.min(100, score));
  const num = size === "lg" ? "text-5xl" : size === "sm" ? "text-2xl" : "text-3xl";
  const track = size === "sm" ? "h-2" : "h-2.5";

  return (
    <div>
      <div className="flex flex-wrap items-end justify-between gap-x-3 gap-y-1">
        <div className="flex items-end gap-2">
          <span className={`font-display ${num} font-extrabold ${b.text}`}>{score}</span>
          <span className="pb-1 text-sm text-ink-faint">/ 100</span>
          {delta != null && delta !== 0 && (
            <span className={`pb-1.5 text-xs font-semibold ${delta > 0 ? "text-trust-direct" : "text-trust-low"}`}>
              {delta > 0 ? "▲" : "▼"} {Math.abs(delta)}
            </span>
          )}
        </div>
        {showBand && <span className={`chip ${score >= 60 ? "bg-trust-direct/15 text-trust-direct" : score >= 40 ? "bg-brand-soft text-brand" : "bg-coral/15 text-coral-dark"}`}>{b.word}</span>}
      </div>
      {/* track with 40 / 60 band ticks */}
      <div className={`relative mt-2 w-full overflow-hidden rounded-full bg-surface-sunken ${track}`}>
        <span className={`block h-full rounded-full ${b.fill}`} style={{ width: `${pct}%` }} />
        <span className="absolute inset-y-0 w-px bg-white/70" style={{ left: "40%" }} aria-hidden />
        <span className="absolute inset-y-0 w-px bg-white/70" style={{ left: "60%" }} aria-hidden />
      </div>
      {sub && <p className="mt-1.5 text-xs text-ink-faint">{sub}</p>}
    </div>
  );
}
