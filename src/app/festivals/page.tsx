import { activeWorkspace } from "@/lib/workspace";
import { ScreenNotReady } from "@/components/ScreenNotReady";
import { PillarBuilding } from "@/components/PillarBuilding";
import { CollectingScreen } from "@/components/CollectingScreen";
import { ActOnIt } from "@/components/ActOnIt";
import { withinBudget } from "@/lib/pillarBudget";
import { collectionActive } from "@/lib/jobs";
import { getOrMakeFestivalPlanner } from "@/lib/festival";

export const dynamic = "force-dynamic";
export const maxDuration = 45;

function whenLabel(inDays: number): string {
  if (inDays <= 0) return "today";
  if (inDays === 1) return "tomorrow";
  if (inDays <= 21) return `in ${inDays} days`;
  const wk = Math.round(inDays / 7);
  return `in ~${wk} weeks`;
}

/**
 * Festival planner — the upcoming occasions that fit THIS business (audience +
 * what they sell), each with a grounded campaign and a one-tap draft. Cultural
 * festivals included, so diaspora businesses see Diwali/Eid/Lunar New Year in time.
 */
export default async function FestivalsPage() {
  const state = await activeWorkspace();
  if (state.status !== "ok") return <ScreenNotReady state={state} title="Festivals" />;
  const ws = state.workspace;
  if (await collectionActive(ws.id)) return <CollectingScreen workspaceId={ws.id} title="Festivals" />;

  const report = await withinBudget(getOrMakeFestivalPlanner(ws));
  if (!report) return <PillarBuilding title="Festivals" subtitle="Matching upcoming occasions to what you sell…" />;

  return (
    <div className="animate-fade-in space-y-5">
      <div>
        <p className="text-sm font-medium text-brand-deep">Ask Rani Insights</p>
        <h1 className="mt-1 font-display text-3xl font-extrabold tracking-tight">Festival planner</h1>
        <p className="mt-1 text-sm text-ink-soft">The occasions that fit your business — with a ready campaign, so you prep in time instead of the week of.</p>
      </div>

      {report.empty ? (
        <div className="card border-dashed">
          <p className="text-sm text-ink-soft"><span className="font-semibold text-ink">Nothing fitting in the next few weeks.</span> Rani checks the calendar — including cultural festivals — and will surface the ones that match what you sell, with a campaign, as they approach.</p>
        </div>
      ) : (
        <>
          {report.summary && (
            <div className="card">
              <div className="flex items-start gap-3">
                <span className="grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-brand text-sm text-white">🎉</span>
                <div>
                  <p className="text-xs font-semibold uppercase tracking-wide text-brand-deep">Start with this</p>
                  <p className="mt-1 text-sm text-ink">{report.summary}</p>
                </div>
              </div>
            </div>
          )}

          <div className="space-y-3">
            {report.plans.map((p, i) => (
              <div key={i} className="card">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-display text-lg font-extrabold text-ink">{p.occasion}</span>
                  <span className="chip bg-brand-soft text-brand">{whenLabel(p.inDays)}</span>
                  {p.audience && p.audience !== "general" && <span className="chip bg-surface-sunken text-ink-faint">{p.audience}</span>}
                </div>
                {p.why && <p className="mt-1.5 text-sm text-ink-soft">{p.why}</p>}
                <ul className="mt-2 space-y-1.5">
                  {p.moves.map((m, j) => (
                    <li key={j} className="flex gap-2 text-sm text-ink"><span className="text-brand" aria-hidden>→</span><span>{m}</span></li>
                  ))}
                </ul>
                <div className="mt-3">
                  <ActOnIt kind={p.act.kind} move={p.act.move} context={p.act.context} label="Draft the campaign" small />
                </div>
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
