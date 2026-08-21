/**
 * Graceful "still analyzing" state for a heavy pillar whose first cold-cache build
 * exceeded the render budget (see lib/pillarBudget). The build keeps running in the
 * background and caches, so the next visit is instant — this just replaces the
 * endless spinner with an honest, bounded message + a one-tap refresh.
 */
export function PillarBuilding({ title, subtitle }: { title: string; subtitle?: string }) {
  return (
    <div className="animate-fade-in space-y-6">
      <div>
        <p className="text-sm font-medium text-brand-deep">Ask Rani Insights</p>
        <h1 className="mt-1 font-display text-3xl font-extrabold tracking-tight">{title}</h1>
      </div>
      <div className="card flex flex-col items-center gap-3 py-10 text-center">
        <span className="rani-dots" aria-hidden><span /><span /><span /></span>
        <p className="text-sm font-semibold text-ink">Rani is still analyzing this — hang tight.</p>
        <p className="max-w-md text-sm text-ink-soft">
          {subtitle ?? "This view synthesizes several signals across your market. The first build takes a moment; it’s finishing in the background and will be ready shortly."}
        </p>
        <a href="" className="btn btn-primary mt-1 px-5 py-2 text-sm">Refresh</a>
      </div>
    </div>
  );
}
