import { activeWorkspace } from "@/lib/workspace";
import { ScreenNotReady } from "@/components/ScreenNotReady";
import { getObjectives } from "@/lib/objectives";
import { buildScorecard } from "@/lib/scorecard";
import { ObjectivesBoard } from "@/components/ObjectivesBoard";

export const dynamic = "force-dynamic";
export const maxDuration = 45;
export const metadata = { title: "Your plan — Ask Rani Insights" };

export default async function PlanPage() {
  const state = await activeWorkspace();
  if (state.status !== "ok") return <ScreenNotReady state={state} title="Your plan" />;
  const ws = state.workspace;
  const [objectives, sc] = await Promise.all([getObjectives(ws), buildScorecard(ws)]);
  const standing = sc.empty
    ? { you: null, rank: null, total: 0, leader: null, leaderScore: null }
    : { you: sc.composite.you, rank: sc.composite.rank, total: sc.composite.total, leader: sc.composite.bestName, leaderScore: sc.composite.best };

  return (
    <div className="animate-fade-in space-y-6">
      <header>
        <p className="text-sm font-medium text-brand-deep">Ask Rani Insights</p>
        <h1 className="mt-1 font-display text-3xl font-extrabold tracking-tight">Your plan to stand out</h1>
        <p className="mt-1 max-w-2xl text-sm text-ink-soft">
          Daily, weekly and monthly milestones to close the gaps on your market — set from your data, competitors and what&apos;s coming up, and ticked off automatically as you improve.
        </p>
      </header>

      {objectives && !objectives.empty ? (
        <ObjectivesBoard report={objectives} standing={standing} businessName={ws.name} vertical={ws.vertical} />
      ) : (
        <div className="card border-dashed">
          <p className="text-sm text-ink-soft">
            <span className="font-semibold text-ink">No milestones yet.</span> Once we&apos;ve read your market, Rani sets your daily/weekly/monthly plan and starts tracking it — refresh from the Week page to kick it off.
          </p>
        </div>
      )}
    </div>
  );
}
