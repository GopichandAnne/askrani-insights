import { RaniMark } from "@/components/RaniSpinner";

/**
 * Branded loading mask — a spinning teal ring around a bobbing Rani + a pulsing
 * label. Matches app.askrani.ai's BrandLoader exactly so the two products feel
 * like one. Used as the route-transition mask and anywhere a page waits.
 */
export function BrandLoader({ label = "Loading…", className = "" }: { label?: string; className?: string }) {
  return (
    <div className={`flex min-h-[70vh] w-full flex-col items-center justify-center gap-5 ${className}`}>
      <div className="relative grid h-20 w-20 place-items-center">
        {/* spinning gradient ring */}
        <span className="absolute inset-0 animate-spin rounded-full border-4 border-brand-soft border-t-brand" />
        {/* soft glow */}
        <span className="absolute inset-1 rounded-full bg-brand/10 blur-md" aria-hidden />
        <span className="animate-bob"><RaniMark size={36} /></span>
      </div>
      <p className="animate-pulse text-sm text-ink-faint">{label}</p>
    </div>
  );
}

/** Content mask — matches the app's Skeleton (animate-pulse rounded block). */
export function Skeleton({ className = "" }: { className?: string }) {
  return <div className={`animate-pulse rounded-md bg-brand/10 ${className}`} aria-hidden />;
}
