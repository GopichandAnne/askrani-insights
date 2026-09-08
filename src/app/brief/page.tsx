import { activeWorkspace } from "@/lib/workspace";
import { getOrMakeAttention } from "@/lib/attention";
import { buildScorecard } from "@/lib/scorecard";
import { ScreenNotReady } from "@/components/ScreenNotReady";
import { CollectingScreen } from "@/components/CollectingScreen";
import { collectionActive } from "@/lib/jobs";
import { AttentionView } from "@/components/AttentionView";
import { AttentionControls } from "@/components/AttentionControls";
import { BriefPosition } from "@/components/BriefPosition";
import { RecentAlerts } from "@/components/RecentAlerts";
import type { AlertLogEntry } from "@/lib/alerts";

export const dynamic = "force-dynamic";
export const maxDuration = 45;

/**
 * "Today" — the decision-first surface (Phase 2 of the Rani Brief redesign). Reads
 * the attention board (the 2-4 that need attention, competitor & pricing first,
 * plus everything moving) and leads with decisions, not a dashboard. This is the
 * view a brief's deep-link will open; the attention layer that powers it is
 * deterministic (no LLM), so it never fails on the render path.
 */
export default async function BriefPage() {
  const state = await activeWorkspace();
  if (state.status !== "ok") return <ScreenNotReady state={state} title="Today" />;
  const ws = state.workspace;
  if (await collectionActive(ws.id)) return <CollectingScreen workspaceId={ws.id} title="Today" />;

  // Attention board (decisions) + competitive scorecard (where you stand), in
  // parallel. The scorecard is a self-healing read; if it throws we still render
  // the decision surface — the brief must never fail on the position strip.
  const [board, sc] = await Promise.all([
    getOrMakeAttention({ id: ws.id, name: ws.name, vertical: ws.vertical }),
    buildScorecard(ws).catch(() => null),
  ]);
  const alertLog = ((ws.goals as Record<string, unknown> | null)?.alertLog as AlertLogEntry[]) ?? [];

  return (
    <div className="animate-fade-in space-y-5">
      <div>
        <p className="text-sm font-medium text-brand-deep">Ask Rani Insights</p>
        <h1 className="mt-1 font-display text-3xl font-extrabold tracking-tight">{board.headline}</h1>
        <p className="mt-1 text-sm text-ink-soft">{board.statusLine}</p>
      </div>
      {sc && <BriefPosition sc={sc} />}
      <RecentAlerts log={alertLog} />
      <AttentionControls mode={board.mode} objective={board.objective} />
      <AttentionView board={board} />
    </div>
  );
}
