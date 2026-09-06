import { activeWorkspace } from "@/lib/workspace";
import { isAreaMode } from "@/lib/subject";
import { createClient } from "@/lib/supabase/server";
import { ScreenNotReady } from "@/components/ScreenNotReady";
import { CompetitorsMap } from "@/components/CompetitorsMap";
import { CompetitorCards } from "@/components/CompetitorCards";
import { ConfirmMarket } from "@/components/ConfirmMarket";
import { MarketTabs } from "@/components/MarketTabs";
import { competitorCards } from "@/lib/competitors";
import { getOrMakePriceGaps, type PriceGap } from "@/lib/pricegaps";
import { getOrMakeBattlegrounds } from "@/lib/battlegrounds";
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
      .select("id,relation,score,competitor_id,score_components,competitor:competitor_id(canonical_name,attributes)")
      .eq("workspace_id", state.workspace.id)
      .is("active_to", null)
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

  // primary competitors for the "did we get your market right?" confirm step (target mode only)
  const primaryComps = (edges ?? [])
    .filter((e) => e.relation === "primary" && (e as any).competitor_id && (e as any).score_components?.relationship !== "occasion")
    .map((e) => ({
      id: (e as any).competitor_id as string,
      name: ((e.competitor as any)?.canonical_name as string) ?? "Competitor",
      match: typeof (e as any).score_components?.similarity === "number" ? (e as any).score_components.similarity : Number(e.score),
    }));

  // occasion competitors — different specialty, but they win the same purchase
  // occasion (weekday lunch, late-night, delivery). Surfaced as their own group.
  const occasionComps = (edges ?? [])
    .filter((e) => (e as any).score_components?.relationship === "occasion")
    .map((e) => ({
      name: ((e.competitor as any)?.canonical_name as string) ?? "Competitor",
      why: ((e as any).score_components?.rationale as string) ?? "",
    }))
    .slice(0, 6);

  // grocery price battlegrounds — where each rival undercuts you on shared items
  const battlegrounds = !area && state.workspace.vertical === "grocery" ? await getOrMakeBattlegrounds(state.workspace) : null;

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

      {/* confirm-your-market — cleans the set + banks labeled training data (target mode) */}
      {!area && <ConfirmMarket competitors={primaryComps} />}

      {/* primary: per-competitor cards */}
      <CompetitorCards data={cardData} gapsByRival={gapsByRival} />

      {/* grocery price battlegrounds — competition is item-specific, not one verdict */}
      {battlegrounds && !battlegrounds.empty && (
        <section className="card">
          <h2 className="mb-1 flex items-center gap-2 font-semibold">
            <span className="grid h-7 w-7 place-items-center rounded-lg bg-brand-soft text-brand">🛒</span>
            Price battlegrounds
          </h2>
          <p className="mb-3 text-sm text-ink-soft">{battlegrounds.summary}</p>
          <ul className="divide-y divide-line/60">
            {battlegrounds.rivals.map((r, i) => (
              <li key={i} className="flex items-baseline justify-between gap-3 py-2 text-sm">
                <span className="text-ink">{r.name}</span>
                <span className={`shrink-0 text-right text-[12px] ${r.cheaper >= Math.max(3, Math.round(r.overlap * 0.4)) ? "text-coral-dark" : "text-ink-faint"}`}>{r.note}</span>
              </li>
            ))}
          </ul>
          <p className="mt-2 text-[11px] text-ink-faint">Based on items you and each rival both price. A rival can be a weak overall match yet a sharp price competitor on staples.</p>
        </section>
      )}

      {/* occasion competitors — same customer job, different specialty */}
      {!area && occasionComps.length > 0 && (
        <section className="card">
          <h2 className="mb-1 flex items-center gap-2 font-semibold">
            <span className="grid h-7 w-7 place-items-center rounded-lg bg-brand-soft text-brand">🍽️</span>
            Also competing for your customers&apos; occasions
          </h2>
          <p className="mb-3 text-sm text-ink-faint">Different concept, but they win the same moment — lunch, late-night, delivery. Worth watching even though they&apos;re not direct look-alikes.</p>
          <ul className="divide-y divide-line/60">
            {occasionComps.map((c, i) => (
              <li key={i} className="flex items-baseline justify-between gap-3 py-2 text-sm">
                <span className="text-ink">{c.name}</span>
                {c.why && <span className="shrink-0 text-right text-[11px] text-ink-faint">{c.why}</span>}
              </li>
            ))}
          </ul>
        </section>
      )}

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
