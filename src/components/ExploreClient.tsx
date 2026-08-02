"use client";

import { useState } from "react";
import dynamic from "next/dynamic";
import type { MapPoint } from "@/components/MapPicker";
import type { ExploreResponse, ExploreResult } from "@/lib/explore";

const MapPicker = dynamic(() => import("@/components/MapPicker").then((m) => m.MapPicker), {
  ssr: false,
  loading: () => <div className="grid h-[360px] place-items-center rounded-2xl border border-line/60 bg-surface-sunken text-sm text-ink-faint">Loading map…</div>,
});

const EXAMPLES = [
  { keyword: "boba tea", area: "78641" },
  { keyword: "indian restaurant", area: "Edison NJ" },
  { keyword: "coffee shop", area: "Austin TX" },
  { keyword: "asian grocery", area: "78727" },
];

export function ExploreClient() {
  const [keyword, setKeyword] = useState("");
  const [area, setArea] = useState("");
  const [loading, setLoading] = useState(false);
  const [data, setData] = useState<ExploreResponse | null>(null);

  async function run(kw = keyword, ar = area) {
    if (ar.trim().length < 2) return;
    setLoading(true);
    try {
      const r = await fetch("/api/explore", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ keyword: kw, area: ar }) });
      setData(await r.json());
    } catch (e) {
      setData({ results: [], error: (e as Error).message });
    } finally { setLoading(false); }
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
            placeholder="What are you looking for? (e.g. boba tea, indian restaurant)"
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

          {points.length > 0 && <div className="card p-2"><MapPicker points={points} height={360} /></div>}

          {results.length === 0 ? (
            <p className="rounded-2xl border border-dashed border-line p-6 text-sm text-ink-faint">Nothing found there — try a broader term or a nearby zip.</p>
          ) : (
            <ol className="stagger space-y-2">
              {results.map((r, i) => <ResultRow key={i} r={r} rank={i + 1} />)}
            </ol>
          )}

          <p className="px-1 text-[11px] text-ink-faint">
            Ratings from Google. Want ongoing tracking, prices &amp; social for one of these? <a href="/onboarding" className="font-medium text-brand hover:underline">Set it up as your business →</a>
          </p>
        </>
      )}
    </div>
  );
}

function ResultRow({ r, rank }: { r: ExploreResult; rank: number }) {
  return (
    <li className="card card-hover flex items-center gap-3 py-3">
      <span className="grid h-7 w-7 shrink-0 place-items-center rounded-full bg-surface-sunken text-xs font-bold text-ink-faint">{rank}</span>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-semibold">{r.name}</span>
          <span className="chip bg-brand-soft text-brand-deep">{r.vertical === "grocery" ? "🛒 Grocery" : "🍽️ Restaurant"}{r.subtype ? ` · ${r.subtype}` : ""}</span>
        </div>
        <div className="mt-0.5 truncate text-xs text-ink-faint">
          {r.address ?? ""}{r.distanceKm != null ? ` · ${r.distanceKm}km` : ""}
        </div>
      </div>
      <div className="shrink-0 text-right">
        <div className="font-semibold text-brand-deep">{r.rating != null ? `${r.rating}★` : "—"}</div>
        <div className="text-[11px] text-ink-faint">{r.reviews != null ? `${r.reviews.toLocaleString()} reviews` : "no reviews"}</div>
      </div>
      <div className="flex shrink-0 flex-col items-end gap-1 pl-1">
        {r.mapsUrl && <a href={r.mapsUrl} target="_blank" rel="noreferrer" className="text-xs font-medium text-brand hover:underline">Map</a>}
        {r.website && <a href={r.website} target="_blank" rel="noreferrer" className="text-xs text-ink-faint hover:text-brand">Site</a>}
      </div>
    </li>
  );
}
