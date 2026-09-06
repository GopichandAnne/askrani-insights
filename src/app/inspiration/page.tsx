import { activeWorkspace, workspaceBusinessIds } from "@/lib/workspace";
import { createClient } from "@/lib/supabase/server";
import { ScreenNotReady } from "@/components/ScreenNotReady";
import { CollectingScreen } from "@/components/CollectingScreen";
import { collectionActive } from "@/lib/jobs";
import { getOrMakeInspiration, watchlistIds } from "@/lib/inspiration";
import { InspirationManager } from "@/components/InspirationManager";

export const dynamic = "force-dynamic";
export const maxDuration = 45;

/**
 * Inspiration — businesses you want to emulate, and the concrete moves to borrow
 * from them (format, cadence, hooks). Deliberately separate from rank/price: this
 * is about learning craft, not competing on numbers.
 */
export default async function InspirationPage() {
  const state = await activeWorkspace();
  if (state.status !== "ok") return <ScreenNotReady state={state} title="Inspiration" />;
  const ws = state.workspace;
  if (await collectionActive(ws.id)) return <CollectingScreen workspaceId={ws.id} title="Inspiration" />;

  const [report, db] = await Promise.all([getOrMakeInspiration(ws), createClient()]);
  const ids = await workspaceBusinessIds(ws, db);
  const { data: biz } = await db.from("business").select("id, canonical_name").in("id", ids.competitorIds.length ? ids.competitorIds : ["00000000-0000-0000-0000-000000000000"]);
  const candidates = ((biz ?? []) as any[]).map((b) => ({ id: b.id as string, name: (b.canonical_name as string) ?? "Unnamed" }));
  const watch = watchlistIds(ws.goals as Record<string, any>);

  return (
    <div className="animate-fade-in space-y-5">
      <div>
        <p className="text-sm font-medium text-brand-deep">Ask Rani Insights</p>
        <h1 className="mt-1 font-display text-3xl font-extrabold tracking-tight">Inspiration</h1>
        <p className="mt-1 text-sm text-ink-soft">Businesses you want to emulate — and the moves worth borrowing. Not about price or rank; about craft.</p>
      </div>

      {/* Watchlist manager */}
      <div className="card">
        <h2 className="text-xs font-semibold uppercase tracking-wide text-ink-faint">Your watchlist</h2>
        <p className="mt-0.5 text-sm text-ink-soft">Star the businesses you admire. Rani reads what they post and pulls out what you could borrow.</p>
        <div className="mt-3"><InspirationManager watch={watch} candidates={candidates} /></div>
      </div>

      {report.needsPicks ? (
        <div className="card border-dashed">
          <p className="text-sm text-ink-soft"><span className="font-semibold text-ink">Pick a few to emulate.</span> Star one or more businesses above and Rani will surface the formats, cadence and hooks worth borrowing.</p>
        </div>
      ) : report.empty ? (
        <div className="card border-dashed">
          <p className="text-sm text-ink-soft"><span className="font-semibold text-ink">Nothing to show yet.</span> We don&apos;t have enough posts from your watchlist to learn from — check back after the next collection.</p>
        </div>
      ) : (
        <>
          {report.summary && (
            <div className="card">
              <div className="flex items-start gap-3">
                <span className="grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-brand text-sm text-white">✨</span>
                <div>
                  <p className="text-xs font-semibold uppercase tracking-wide text-brand-deep">Borrow this first</p>
                  <p className="mt-1 text-sm text-ink">{report.summary}</p>
                </div>
              </div>
            </div>
          )}
          <div className="space-y-3">
            {report.picks.map((p, i) => (
              <div key={i} className="card">
                <div className="flex items-center gap-2">
                  <span aria-hidden>★</span>
                  <span className="font-display text-lg font-extrabold text-ink">{p.name}</span>
                </div>
                <ul className="mt-2 space-y-1.5">
                  {p.moves.map((m, j) => (
                    <li key={j} className="flex gap-2 text-sm text-ink"><span className="text-brand" aria-hidden>→</span><span>{m}</span></li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
