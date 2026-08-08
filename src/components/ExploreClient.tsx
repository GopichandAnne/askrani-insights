"use client";

import { useState } from "react";
import dynamic from "next/dynamic";
import { track } from "@/components/Analytics";
import type { MapPoint } from "@/components/MapPicker";
import type { ExploreResponse, ExploreResult, MarketRead } from "@/lib/explore";

const MapPicker = dynamic(() => import("@/components/MapPicker").then((m) => m.MapPicker), {
  ssr: false,
  loading: () => <div className="grid h-[360px] place-items-center rounded-2xl border border-line/60 bg-surface-sunken text-sm text-ink-faint">Loading map…</div>,
});

const EXAMPLES = [
  { keyword: "med spa", area: "Austin TX" },
  { keyword: "boba tea", area: "78641" },
  { keyword: "indian restaurant", area: "Edison NJ" },
  { keyword: "asian grocery", area: "78727" },
];

export function ExploreClient({ signedOut = false }: { signedOut?: boolean }) {
  const [keyword, setKeyword] = useState("");
  const [area, setArea] = useState("");
  const [loading, setLoading] = useState(false);
  const [data, setData] = useState<ExploreResponse | null>(null);
  const [read, setRead] = useState<MarketRead | null>(null);
  const [readLoading, setReadLoading] = useState(false);

  async function run(kw = keyword, ar = area) {
    if (ar.trim().length < 2) return;
    setLoading(true); setRead(null); setReadLoading(false);
    // Key top-of-funnel signal: someone tried the free tool (and what for).
    track("explore_search", { keyword: kw, area: ar, signed_out: signedOut });
    try {
      const r = await fetch("/api/explore", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ keyword: kw, area: ar }) });
      const resp: ExploreResponse = await r.json();
      setData(resp);
      // Progressive: list + map render now; the intelligent market-read streams in
      // a beat later so first paint stays snappy (this is the funnel hook).
      if ((resp.results ?? []).length) void loadRead(kw, ar, resp.results);
    } catch (e) {
      setData({ results: [], error: (e as Error).message });
    } finally { setLoading(false); }
  }

  async function loadRead(kw: string, ar: string, results: ExploreResult[]) {
    setReadLoading(true);
    try {
      const compact = results.slice(0, 25).map((r) => ({ name: r.name, rating: r.rating, reviews: r.reviews, subtype: r.subtype, vertical: r.vertical }));
      const r = await fetch("/api/explore/read", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ keyword: kw, area: ar, results: compact }) });
      if (r.ok) setRead(await r.json());
    } catch { /* the list still stands on its own */ } finally { setReadLoading(false); }
  }

  function monitorArea() {
    track("monitor_intent", { source: "market_read", area, keyword, signed_out: signedOut });
    window.location.href = signedOut ? "/login?next=/onboarding" : "/onboarding";
  }

  // Seamless "Explore → monitor" handoff: stash the picked business so onboarding
  // can pre-fill it, then route to signup (signed-out) or straight to onboarding.
  function monitor(r: ExploreResult) {
    const candidate = {
      name: r.name,
      website: r.website,
      geo: r.geo,
      category: r.category,
      address: r.address,
      platform: "google",
      detectedVertical: r.vertical,
      subtype: [] as string[],
      raw: { place_id: r.placeId, rating: r.rating, userRatingCount: r.reviews, formattedAddress: r.address, primaryType: r.category },
    };
    try { sessionStorage.setItem("ar_explore_pick", JSON.stringify(candidate)); } catch { /* ignore */ }
    // Funnel step: explore → intent to monitor (→ signup for signed-out visitors).
    track("monitor_intent", { business: r.name, vertical: r.vertical, signed_out: signedOut });
    window.location.href = signedOut ? "/login?next=/onboarding" : "/onboarding";
  }

  const results = data?.results ?? [];
  const points: MapPoint[] = results
    .filter((r) => r.geo)
    .map((r, i) => ({ id: String(i), lat: r.geo!.lat, lng: r.geo!.lng, label: r.name, sub: r.rating ? `${r.rating}★ · ${r.reviews ?? 0} reviews` : undefined, tone: "result" }));

  return (
    <div className="space-y-5">
      {/* search bar */}
      <div className="glass-strong rounded-3xl p-4">
        <div className="flex flex-col gap-2 sm:flex-row">
          <input
            value={keyword}
            onChange={(e) => setKeyword(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && run()}
            placeholder="What are you looking for? (e.g. med spa, boba tea, indian restaurant)"
            className="field flex-1"
          />
          <input
            value={area}
            onChange={(e) => setArea(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && run()}
            placeholder="Zip or city (e.g. 78641)"
            className="field sm:w-56"
          />
          <button onClick={() => run()} disabled={loading || area.trim().length < 2} className="btn btn-primary px-6 py-2.5 disabled:opacity-60">
            {loading ? "Scanning…" : "Explore"}
          </button>
        </div>
        {!data && (
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <span className="text-xs text-ink-faint">Try:</span>
            {EXAMPLES.map((ex, i) => (
              <button key={i} onClick={() => { setKeyword(ex.keyword); setArea(ex.area); run(ex.keyword, ex.area); }} className="chip bg-surface-sunken text-ink-soft transition-colors hover:bg-brand-soft hover:text-brand-deep">
                {ex.keyword} · {ex.area}
              </button>
            ))}
          </div>
        )}
      </div>

      {loading && (
        <div className="glass flex items-center gap-3 rounded-2xl p-5">
          <span className="rani-dots" aria-hidden><span /><span /><span /></span>
          <span className="text-sm text-ink-soft">Scanning the area…</span>
        </div>
      )}

      {data?.error && !loading && <p className="rounded-2xl border border-trust-low/30 bg-trust-low/5 p-3 text-sm text-trust-low">{data.error}</p>}

      {!loading && data && !data.error && (
        <>
          <p className="px-1 text-sm text-ink-soft">
            <span className="font-semibold text-ink">{results.length}</span> {keyword.trim() || "places"}{data.areaLabel ? <> near <span className="font-semibold text-ink">{data.areaLabel}</span></> : ""} · best-rated first
          </p>

          {results.length > 0 && (
            <MarketReadPanel
              read={read}
              loading={readLoading}
              areaLabel={data.areaLabel ?? area}
              keyword={keyword.trim()}
              signedOut={signedOut}
              onMonitor={monitorArea}
            />
          )}

          {points.length > 0 && <div className="card p-2"><MapPicker points={points} height={360} /></div>}

          {results.length === 0 ? (
            <p className="rounded-2xl border border-dashed border-line p-6 text-sm text-ink-faint">Nothing found there — try a broader term or a nearby zip.</p>
          ) : (
            <ol className="stagger space-y-2">
              {results.map((r, i) => <ResultRow key={i} r={r} rank={i + 1} onMonitor={() => monitor(r)} />)}
            </ol>
          )}

          <p className="px-1 text-[11px] text-ink-faint">
            Ratings from Google. Want ongoing tracking — prices, social, delivery menus &amp; alerts — for one of these?{" "}
            {signedOut
              ? <a href="/login" className="font-medium text-brand hover:underline">Sign up to monitor a business →</a>
              : <a href="/onboarding" className="font-medium text-brand hover:underline">Set it up as your business →</a>}
          </p>
        </>
      )}
    </div>
  );
}

/** The intelligent market-read — a one-screen analyst take on the area, plus the
 *  area-level conversion CTA. This is the hook that turns a free scan into a
 *  monitored business. */
function MarketReadPanel({
  read, loading, areaLabel, keyword, signedOut, onMonitor,
}: { read: MarketRead | null; loading: boolean; areaLabel: string; keyword: string; signedOut: boolean; onMonitor: () => void }) {
  const s = read?.stats;
  return (
    <section className="glass-strong relative overflow-hidden rounded-3xl p-5 sm:p-6">
      <div className="pointer-events-none absolute inset-0 bg-brand-mesh opacity-[0.08]" aria-hidden />
      <div className="relative">
        <div className="flex items-center gap-2">
          <span className="grid h-7 w-7 place-items-center rounded-xl bg-brand-gradient text-white shadow-brand" aria-hidden>📊</span>
          <p className="text-xs font-semibold uppercase tracking-wide text-brand-deep">Market read{areaLabel ? ` · ${areaLabel}` : ""}</p>
        </div>

        {loading && !read ? (
          <div className="mt-3 flex items-center gap-3">
            <span className="rani-dots" aria-hidden><span /><span /><span /></span>
            <span className="text-sm text-ink-faint">Sizing up the market…</span>
          </div>
        ) : read ? (
          <>
            <h3 className="mt-2 font-display text-lg font-extrabold tracking-tight sm:text-xl">{read.headline}</h3>

            {s && (
              <div className="mt-3 flex flex-wrap gap-2">
                <Stat label={keyword || "places"} value={String(s.count)} />
                {s.avgRating != null && <Stat label="avg rating" value={`${s.avgRating}★`} />}
                <Stat label="standouts" value={String(s.highPerformers)} />
                {s.mostReviewed && <Stat label="most reviewed" value={s.mostReviewed.name} />}
                {s.subtypeMix[0] && <Stat label="most common" value={`${s.subtypeMix[0].label} (${s.subtypeMix[0].count})`} />}
              </div>
            )}

            {read.readout.length > 0 && (
              <ul className="mt-3 space-y-1.5">
                {read.readout.map((b, i) => (
                  <li key={i} className="flex gap-2 text-sm text-ink-soft"><span className="text-brand" aria-hidden>•</span><span>{b}</span></li>
                ))}
              </ul>
            )}

            {read.opportunity && (
              <div className="mt-3 rounded-2xl border border-brand/25 bg-brand-soft/50 p-3">
                <div className="text-[11px] font-semibold uppercase tracking-wide text-brand-deep">The opening</div>
                <p className="mt-0.5 text-sm text-ink">{read.opportunity}</p>
              </div>
            )}
          </>
        ) : null}

        {/* area-level conversion CTA — always shown once there are results */}
        <div className="mt-4 flex flex-col gap-2 border-t border-line/50 pt-4 sm:flex-row sm:items-center sm:justify-between">
          <p className="text-sm text-ink-soft">Want this market watched for you — competitors, prices, deals, reviews &amp; a weekly digest?</p>
          <button onClick={onMonitor} className="btn btn-primary shrink-0 px-5 py-2.5 text-sm">
            {signedOut ? "Monitor my business here →" : "Monitor my business in this area →"}
          </button>
        </div>
      </div>
    </section>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <span className="inline-flex items-baseline gap-1.5 rounded-full bg-white/70 px-3 py-1">
      <span className="text-sm font-bold text-brand-deep">{value}</span>
      <span className="text-[11px] text-ink-faint">{label}</span>
    </span>
  );
}

function ResultRow({ r, rank, onMonitor }: { r: ExploreResult; rank: number; onMonitor: () => void }) {
  return (
    <li className="card card-hover flex items-center gap-3 py-3">
      <span className="grid h-7 w-7 shrink-0 place-items-center rounded-full bg-surface-sunken text-xs font-bold text-ink-faint">{rank}</span>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-semibold">{r.name}</span>
          <span className="chip bg-brand-soft text-brand-deep">{r.vertical === "grocery" ? "🛒 Grocery" : r.vertical === "salon" ? "💆 Beauty & spa" : "🍽️ Restaurant"}{r.subtype ? ` · ${r.subtype}` : ""}</span>
        </div>
        <div className="mt-0.5 truncate text-xs text-ink-faint">
          {r.address ?? ""}{r.distanceKm != null ? ` · ${r.distanceKm}km` : ""}
        </div>
      </div>
      <div className="hidden shrink-0 text-right sm:block">
        <div className="font-semibold text-brand-deep">{r.rating != null ? `${r.rating}★` : "—"}</div>
        <div className="text-[11px] text-ink-faint">{r.reviews != null ? `${r.reviews.toLocaleString()} reviews` : "no reviews"}</div>
      </div>
      <button onClick={onMonitor} className="btn btn-secondary shrink-0 px-3 py-1.5 text-xs" title="Track this business + its competitors">Monitor →</button>
    </li>
  );
}
