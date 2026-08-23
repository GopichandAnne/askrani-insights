import { activeWorkspace } from "@/lib/workspace";
import { ScreenNotReady } from "@/components/ScreenNotReady";
import { CollectingScreen } from "@/components/CollectingScreen";
import { collectionActive } from "@/lib/jobs";
import { buildScorecard } from "@/lib/scorecard";
import { ScorecardView } from "@/components/ScorecardView";
import { ShareReadButton } from "@/components/ShareReadButton";

export const dynamic = "force-dynamic";
export const maxDuration = 45;
export const metadata = { title: "You vs Your Market — Ask Rani Insights" };

export default async function ScorecardPage() {
  const state = await activeWorkspace();
  if (state.status !== "ok") return <ScreenNotReady state={state} title="You vs Your Market" />;
  if (await collectionActive(state.workspace.id)) return <CollectingScreen workspaceId={state.workspace.id} title="You vs Your Market" />;
  const sc = await buildScorecard(state.workspace);

  return (
    <div className="animate-fade-in space-y-6">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <p className="text-sm font-medium text-brand-deep">Ask Rani Insights</p>
          <h1 className="mt-1 font-display text-3xl font-extrabold tracking-tight">You vs Your Market</h1>
          <p className="mt-1 max-w-2xl text-sm text-ink-soft">How you stack up against your competitors — rating, price, social reach, AI &amp; Google findability — at a glance, with a plan to beat them.</p>
        </div>
        {!sc.empty && <ShareReadButton />}
      </header>

      {sc.empty ? (
        <div className="card border-dashed">
          <p className="text-sm text-ink-soft"><span className="font-semibold text-ink">Not enough data yet.</span> Once we&apos;ve collected ratings, prices and listings across your market, your scorecard fills in — refresh from the Week page to kick it off.</p>
        </div>
      ) : (
        <>
          <ScorecardView sc={sc} businessName={state.workspace.name} />
          <p className="text-center text-xs text-ink-faint">Scores are 0–100, computed from ratings, tracked prices, social following, AI-assistant mentions and Google search share across your market.</p>
        </>
      )}
    </div>
  );
}
