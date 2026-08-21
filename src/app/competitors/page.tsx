import { activeWorkspace } from "@/lib/workspace";
import { isAreaMode } from "@/lib/subject";
import { createClient } from "@/lib/supabase/server";
import { ScreenNotReady } from "@/components/ScreenNotReady";
import { CompetitorsMap } from "@/components/CompetitorsMap";
import { CompetitorCards } from "@/components/CompetitorCards";
import { MarketTabs } from "@/components/MarketTabs";
import { competitorCards } from "@/lib/competitors";
import { getOrMakePriceGaps, type PriceGap } from "@/lib/pricegaps";
import type { MapPoint } from "@/components/MapPicker";

const normName = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");
const priceNum = (s?: string) => { const m = String(s ?? "").match(/(\d+(?:\.\d+)?)/); return m ? Number(m[1]) : null; };
const gapMag = (g: PriceGap) => { const y = priceNum(g.yourPrice), r = priceNum(g.rivalPrice); return y != null && r != null ? Math.abs(y - r) : -1; };

export const dynamic = "force-dynamic";
export const maxDuration = 45; // buildWorkspaceReport + priceGaps (cold-cache LLM)

type Geo = { lat: number; lng: number };
const geoOf = (attrs: unknown): Geo | null => {
  const g = (attrs as { geo?: Geo } | null)?.geo;
  return g && Number.isFinite(g.lat) && Number.isFinite(g.lng) ? g : null;
};

export default async function CompetitorsPage() {
  const state = await activeWorkspace();
  if (state.status !== "ok") return <ScreenNotReady state={state} title="Competitors" />;
  const area = isAreaMode(state.workspace);

  const supabase = await createClient();
  const [{ data: edges }, { data: target }, cardData, priceGaps] = await Promise.all([
    supabase
      .from("competitor_edge")
      .select("id,relation,score,competitor:competitor_id(canonical_name,attributes)")
      .eq("workspace_id", state.workspace.id)
      .order("score", { ascending: false }),
    state.workspace.target_business_id
      ? supabase.from("business").select("canonical_name,attributes").eq("id", state.workspace.target_business_id).maybeSingle()
      : Promise.resolve({ data: null }),
    competitorCards(state.workspace),
    getOrMakePriceGaps(state.workspace),
  ]);

  // per-rival "you vs them" price gaps, biggest first — the drill-down default.
  const gapsByRival: Record<string, PriceGap[]> = {};
  for (const g of priceGaps.gaps ?? []) { (gapsByRival[normName(g.rival)] ??= []).push(g); }
  for (const k of Object.keys(gapsByRival)) gapsByRival[k].sort((a, b) => gapMag(b) - gapMag(a));

  // map points: your business (if geo) + each competitor with geo
  const points: MapPoint[] = [];
  const tGeo = geoOf((target as any)?.attributes);
  if (tGeo) points.push({ id: "target", lat: tGeo.lat, lng: tGeo.lng, label: (target as any)?.canonical_name ?? state.workspace.name, sub: "Your business", tone: "target" });
  for (const e of edges ?? []) {
    const g = geoOf((e.competitor as any)?.attributes);
    if (g) points.push({ id: `comp:${e.id}`, lat: g.lat, lng: g.lng, label: (e.competitor as any)?.canonical_name ?? "Competitor", sub: `${e.relation} · score ${Number(e.score).toFixed(2)}`, tone: "competitor", action: "Remove" });
  }
  const mapped = points.filter((p) => p.id !== "target").length;

  return (
    <div className="animate-fade-in space-y-6">
      <div>
        <p className="text-sm font-medium text-brand-deep">Ask Rani Insights</p>
        <h1 className="mt-1 font-display text-3xl font-extrabold tracking-tight">{area ? "The businesses here" : "Competitors"}</h1>
        <p className="mt-1 max-w-2xl text-sm text-ink-soft">
          {area
            ? <>Every business across {state.workspace.name} — rating, prices, latest move and best post — in one card each.</>
            : <>Everything each rival is doing for {state.workspace.name} — their rating, prices, latest move and best post — in one card each. No hopping between screens.</>}
        </p>
      </div>

      <MarketTabs />

      {/* primary: per-competitor cards */}
      <CompetitorCards data={cardData} gapsByRival={gapsByRival} />

      {/* secondary: the map */}
      {points.length > 0 && (
        <section className="card">
          <h2 className="mb-3 flex items-center gap-2 font-semibold">
            <span className="grid h-7 w-7 place-items-center rounded-lg bg-brand-soft text-brand">📍</span>
            On the map
          </h2>
          <CompetitorsMap points={points} />
          {mapped < (edges?.length ?? 0) && (
            <p className="mt-1.5 px-1 text-xs text-ink-faint">
              Showing {mapped} of {edges?.length} competitors on the map — the rest don&apos;t have a location on record yet.
            </p>
          )}
        </section>
      )}
    </div>
  );
}
