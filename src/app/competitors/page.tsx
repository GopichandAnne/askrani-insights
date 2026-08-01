import { activeWorkspace } from "@/lib/workspace";
import { createClient } from "@/lib/supabase/server";
import { ScreenNotReady } from "@/components/ScreenNotReady";
import { CompetitorsMap } from "@/components/CompetitorsMap";
import type { MapPoint } from "@/components/MapPicker";

export const dynamic = "force-dynamic";

type Geo = { lat: number; lng: number };
const geoOf = (attrs: unknown): Geo | null => {
  const g = (attrs as { geo?: Geo } | null)?.geo;
  return g && Number.isFinite(g.lat) && Number.isFinite(g.lng) ? g : null;
};

export default async function CompetitorsPage() {
  const state = await activeWorkspace();
  if (state.status !== "ok") return <ScreenNotReady state={state} title="Competitors" />;

  const supabase = await createClient();
  const [{ data: edges }, { data: target }] = await Promise.all([
    supabase
      .from("competitor_edge")
      .select("id,relation,tier,score,score_components,rationale,competitor:competitor_id(canonical_name,website,attributes)")
      .eq("workspace_id", state.workspace.id)
      .order("score", { ascending: false }),
    state.workspace.target_business_id
      ? supabase.from("business").select("canonical_name,attributes").eq("id", state.workspace.target_business_id).maybeSingle()
      : Promise.resolve({ data: null }),
  ]);

  // build map points: your business (if geo) + each competitor with geo
  const points: MapPoint[] = [];
  const tGeo = geoOf((target as any)?.attributes);
  if (tGeo) points.push({ id: "target", lat: tGeo.lat, lng: tGeo.lng, label: (target as any)?.canonical_name ?? state.workspace.name, sub: "Your business", tone: "target" });
  for (const e of edges ?? []) {
    const g = geoOf((e.competitor as any)?.attributes);
    if (g) points.push({ id: `comp:${e.id}`, lat: g.lat, lng: g.lng, label: (e.competitor as any)?.canonical_name ?? "Competitor", sub: `${e.relation} · score ${Number(e.score).toFixed(2)}`, tone: "competitor", action: "Remove" });
  }
  const mapped = points.filter((p) => p.id !== "target").length;

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Competitors</h1>
        <p className="mt-1 text-sm text-ink-soft">
          The local rivals we&apos;re watching for {state.workspace.name}, ranked by how close a match
          they are. You can add or remove any of them.
        </p>
      </div>

      {points.length > 0 && (
        <div>
          <CompetitorsMap points={points} />
          {mapped < (edges?.length ?? 0) && (
            <p className="mt-1.5 px-1 text-xs text-ink-faint">
              Showing {mapped} of {edges?.length} competitors on the map — the rest don&apos;t have a location on record yet.
            </p>
          )}
        </div>
      )}

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
