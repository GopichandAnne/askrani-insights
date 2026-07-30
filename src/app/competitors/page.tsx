import { activeWorkspace } from "@/lib/workspace";
import { createClient } from "@/lib/supabase/server";
import { ScreenNotReady } from "@/components/ScreenNotReady";

export const dynamic = "force-dynamic";

export default async function CompetitorsPage() {
  const state = await activeWorkspace();
  if (state.status !== "ok") return <ScreenNotReady state={state} title="Competitors" />;

  const supabase = await createClient();
  const { data: edges } = await supabase
    .from("competitor_edge")
    .select("id,relation,tier,score,score_components,rationale,competitor:competitor_id(canonical_name,website)")
    .eq("workspace_id", state.workspace.id)
    .order("score", { ascending: false });

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Competitors</h1>
        <p className="mt-1 text-sm text-ink-soft">
          The local rivals we&apos;re watching for {state.workspace.name}, ranked by how close a match
          they are. You can add or remove any of them.
        </p>
      </div>

      {!edges?.length ? (
        <p className="rounded-xl border border-dashed border-line bg-surface p-6 text-sm text-ink-soft">
          No competitors saved yet. Add some in a market analysis.
        </p>
      ) : (
        <div className="overflow-hidden rounded-xl border border-line bg-surface">
          <table className="w-full text-sm">
            <thead className="bg-surface-sunken text-left text-ink-faint">
              <tr>
                <th className="px-4 py-2 font-medium">Competitor</th>
                <th className="px-4 py-2 font-medium">Relation</th>
                <th className="px-4 py-2 font-medium">Tier</th>
                <th className="px-4 py-2 font-medium">Score</th>
                <th className="px-4 py-2 font-medium">Why</th>
              </tr>
            </thead>
            <tbody>
              {edges.map((e) => (
                <tr key={e.id} className="border-t border-line align-top">
                  <td className="px-4 py-2 font-medium">
                    {(e.competitor as any)?.canonical_name}
                    <div className="text-xs font-normal text-ink-faint">
                      {(e.competitor as any)?.website}
                    </div>
                  </td>
                  <td className="px-4 py-2">{e.relation}</td>
                  <td className="px-4 py-2">{e.tier}</td>
                  <td className="px-4 py-2">{Number(e.score).toFixed(2)}</td>
                  <td className="px-4 py-2 text-ink-faint">{e.rationale}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
