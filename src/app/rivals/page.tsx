import { activeWorkspace } from "@/lib/workspace";
import { ScreenNotReady } from "@/components/ScreenNotReady";
import { PillarBuilding } from "@/components/PillarBuilding";
import { CollectingScreen } from "@/components/CollectingScreen";
import { ActOnIt } from "@/components/ActOnIt";
import { withinBudget } from "@/lib/pillarBudget";
import { collectionActive } from "@/lib/jobs";
import { getOrMakeRivalReviews } from "@/lib/rivalreviews";

export const dynamic = "force-dynamic";
export const maxDuration = 45;

/**
 * Rival openings — what customers PUNISH your competitors for (mined from the
 * rivals' own reviews) = concrete openings to win those customers, plus the praise
 * you must match. One-tap "act on it" turns each opening into a ready post.
 */
export default async function RivalsPage() {
  const state = await activeWorkspace();
  if (state.status !== "ok") return <ScreenNotReady state={state} title="Rival openings" />;
  const ws = state.workspace;
  if (await collectionActive(ws.id)) return <CollectingScreen workspaceId={ws.id} title="Rival openings" />;

  const report = await withinBudget(getOrMakeRivalReviews(ws));
  if (!report) return <PillarBuilding title="Rival openings" subtitle="Reading your competitors' reviews for openings…" />;

  return (
    <div className="animate-fade-in space-y-5">
      <div>
        <p className="text-sm font-medium text-brand-deep">Ask Rani Insights</p>
        <h1 className="mt-1 font-display text-3xl font-extrabold tracking-tight">Rival openings</h1>
        <p className="mt-1 text-sm text-ink-soft">What customers punish your competitors for — and what they love. Straight from your rivals&apos; own reviews.</p>
      </div>

      {report.empty ? (
        <div className="card border-dashed">
          <p className="text-sm text-ink-soft">
            <span className="font-semibold text-ink">Nothing mined yet.</span> Once we&apos;ve collected enough of your competitors&apos; reviews, Rani will surface the recurring complaints you can win on — and the praise you need to match.
          </p>
        </div>
      ) : (
        <>
          {report.summary && (
            <div className="card">
              <div className="flex items-start gap-3">
                <span className="grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-brand text-sm text-white">🎯</span>
                <div>
                  <p className="text-xs font-semibold uppercase tracking-wide text-brand-deep">The opening</p>
                  <p className="mt-1 text-sm text-ink">{report.summary}</p>
                  {report.rivalsRead > 0 && <p className="mt-1 text-xs text-ink-faint">Mined from {report.rivalsRead} competitor{report.rivalsRead === 1 ? "" : "s"}&apos; reviews.</p>}
                </div>
              </div>
            </div>
          )}

          {/* Openings — recurring complaints about rivals */}
          {report.gaps.length > 0 && (
            <div className="space-y-3">
              <h2 className="text-sm font-semibold uppercase tracking-wide text-ink-faint">Openings — what rivals get punished for</h2>
              {report.gaps.map((g, i) => (
                <div key={i} className="card">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-display text-lg font-extrabold text-ink">{g.theme}</span>
                    {g.rivals.slice(0, 3).map((r) => (
                      <span key={r} className="chip bg-surface-sunken text-ink-faint">{r}</span>
                    ))}
                  </div>
                  {g.evidence && <p className="mt-1.5 text-sm text-ink-soft">{g.evidence}</p>}
                  {g.angle && (
                    <div className="mt-2 rounded-xl bg-brand-soft/60 p-3">
                      <p className="text-xs font-semibold uppercase tracking-wide text-brand-deep">Your move</p>
                      <p className="mt-0.5 text-sm text-ink">{g.angle}</p>
                    </div>
                  )}
                  <div className="mt-3">
                    <ActOnIt kind="content" move={g.angle || `Win customers frustrated by ${g.theme} at competitors`} context={g.evidence} label="Draft the post" small />
                  </div>
                </div>
              ))}
            </div>
          )}

          {/* Bars to match — recurring praise */}
          {report.strengths.length > 0 && (
            <div className="card">
              <h2 className="text-xs font-semibold uppercase tracking-wide text-ink-faint">Bars to match — what rivals are loved for</h2>
              <div className="mt-3 flex flex-wrap gap-2">
                {report.strengths.map((s, i) => (
                  <span key={i} className="inline-flex items-center gap-1.5 rounded-full border border-line bg-white/60 px-3 py-1.5 text-sm text-ink-soft">
                    <span aria-hidden>💚</span> {s.theme}
                  </span>
                ))}
              </div>
              <p className="mt-2 text-xs text-ink-faint">These are table stakes in your market — make sure you&apos;re at least as strong here.</p>
            </div>
          )}
        </>
      )}
    </div>
  );
}
