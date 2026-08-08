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

  const [deepFor, setDeepFor] = useState<{ r: ExploreResult; scope: "single" | "area" } | null>(null);

  // Seamless "Explore → monitor" handoff: stash the picked business so onboarding
  // can pre-fill it, then route to signup (signed-out) or straight to onboarding.
  function monitor(r: ExploreResult) {
    try { sessionStorage.setItem("ar_explore_pick", JSON.stringify(toCandidate(r))); } catch { /* ignore */ }
    // Funnel step: explore → intent to monitor (→ signup for signed-out visitors).
    track("monitor_intent", { business: r.name, vertical: r.vertical, signed_out: signedOut });
    window.location.href = signedOut ? "/login?next=/onboarding" : "/onboarding";
  }

  // Paid deep read: signed-out visitors must sign in first (it costs credits).
  function openDeep(r: ExploreResult, scope: "single" | "area") {
    if (signedOut) { track("deep_read_intent", { business: r.name, scope, signed_out: true }); window.location.href = "/login?next=/explore"; return; }
    track("deep_read_intent", { business: r.name, scope, signed_out: false });
    setDeepFor({ r, scope });
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
              onDeep={() => results[0] && openDeep(results[0], "area")}
            />
          )}

          {points.length > 0 && <div className="card p-2"><MapPicker points={points} height={360} /></div>}

          {results.length === 0 ? (
            <p className="rounded-2xl border border-dashed border-line p-6 text-sm text-ink-faint">Nothing found there — try a broader term or a nearby zip.</p>
          ) : (
            <ol className="stagger space-y-2">
              {results.map((r, i) => <ResultRow key={i} r={r} rank={i + 1} onMonitor={() => monitor(r)} onDeep={() => openDeep(r, "single")} />)}
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

      {deepFor && (
        <DeepReadModal
          candidate={toCandidate(deepFor.r)}
          vertical={deepFor.r.vertical}
          initialScope={deepFor.scope}
          label={deepFor.r.name}
          onClose={() => setDeepFor(null)}
        />
      )}
    </div>
  );
}

/** Build the onboarding/deep-read candidate shape from an explore result. */
function toCandidate(r: ExploreResult) {
  return {
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
}

/** The intelligent market-read — a one-screen analyst take on the area, plus the
 *  area-level conversion CTA. This is the hook that turns a free scan into a
 *  monitored business. */
function MarketReadPanel({
  read, loading, areaLabel, keyword, signedOut, onMonitor, onDeep,
}: { read: MarketRead | null; loading: boolean; areaLabel: string; keyword: string; signedOut: boolean; onMonitor: () => void; onDeep: () => void }) {
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

        {/* conversion CTAs — deep read (pay-per-scan) + monitor (ongoing) */}
        <div className="mt-4 flex flex-col gap-2 border-t border-line/50 pt-4 sm:flex-row sm:items-center sm:justify-between">
          <p className="text-sm text-ink-soft">Go deeper — pull the full picture (social, deals, prices, reviews) for this market now, or watch it ongoing.</p>
          <div className="flex shrink-0 flex-wrap gap-2">
            <button onClick={onDeep} className="btn btn-primary px-4 py-2.5 text-sm">🔬 Deep read this market</button>
            <button onClick={onMonitor} className="btn btn-secondary px-4 py-2.5 text-sm">
              {signedOut ? "Monitor a business →" : "Monitor my business →"}
            </button>
          </div>
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

interface Quote { workspaceId: string; scope: "single" | "area"; competitorCount: number; quote: number; balance: number; needsCredits: boolean }

/** Deep read — quote → confirm → run. The scan costs credits, so the exact price
 *  and balance are shown before anything paid runs. On confirm, the ephemeral
 *  workspace is set active and the owner is taken to the report as it collects. */
function DeepReadModal({
  candidate, vertical, initialScope, label, onClose,
}: { candidate: ReturnType<typeof toCandidate>; vertical: string; initialScope: "single" | "area"; label: string; onClose: () => void }) {
  const [scope, setScope] = useState<"single" | "area">(initialScope);
  const [quote, setQuote] = useState<Quote | null>(null);
  const [phase, setPhase] = useState<"idle" | "quoting" | "quoted" | "running">("idle");
  const [err, setErr] = useState<string | null>(null);

  async function getQuote() {
    setPhase("quoting"); setErr(null); setQuote(null);
    try {
      const r = await fetch("/api/explore/deep-read/quote", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ candidate, vertical, scope }) });
      const d = await r.json();
      if (!r.ok) { setErr(d.error ?? "Couldn't price that"); setPhase("idle"); return; }
      setQuote(d); setPhase("quoted");
    } catch (e) { setErr((e as Error).message); setPhase("idle"); }
  }

  async function confirm() {
    if (!quote) return;
    setPhase("running"); setErr(null);
    try {
      const r = await fetch("/api/explore/deep-read/run", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ workspaceId: quote.workspaceId }) });
      const d = await r.json();
      if (!r.ok) { setErr(d.error ?? "Couldn't start the deep read"); setPhase("quoted"); return; }
      if (d.needsCredits) { setErr("Not enough credits."); setPhase("quoted"); return; }
      track("deep_read_confirmed", { scope, quote: quote.quote });
      // make the fresh snapshot the active workspace, then open its report (it
      // fills in as collection runs).
      await fetch("/api/workspace/active", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ workspaceId: quote.workspaceId }) });
      window.location.href = "/";
    } catch (e) { setErr((e as Error).message); setPhase("quoted"); }
  }

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center p-4" role="dialog" aria-modal="true">
      <div className="absolute inset-0 bg-ink/40 backdrop-blur-sm" onClick={onClose} />
      <div className="glass-strong relative z-10 w-full max-w-md rounded-3xl p-5">
        <div className="flex items-start justify-between gap-3">
          <div>
            <div className="text-xs font-semibold uppercase tracking-wide text-brand-deep">Deep read</div>
            <p className="mt-0.5 text-sm font-semibold text-ink">{label}</p>
          </div>
          <button onClick={onClose} className="grid h-7 w-7 shrink-0 place-items-center rounded-full text-ink-faint hover:bg-surface-sunken">✕</button>
        </div>

        <div className="mt-4 grid grid-cols-2 gap-2">
          <ScopeCard active={scope === "single"} onClick={() => { setScope("single"); setPhase("idle"); setQuote(null); }} title="This business" desc="Full profile: reviews, social, deals & pricing" />
          <ScopeCard active={scope === "area"} onClick={() => { setScope("area"); setPhase("idle"); setQuote(null); }} title="This + local rivals" desc="The whole market — a deep competitive report" />
        </div>

        <p className="mt-3 text-sm text-ink-soft">
          A one-time paid snapshot pulled fresh — not ongoing monitoring. You can promote it to live monitoring anytime (and get the credits back).
        </p>

        {err && <p className="mt-3 text-sm text-trust-low">{err}</p>}

        {quote && (
          <div className="mt-3 rounded-2xl bg-white/60 p-3 text-sm">
            <div className="flex items-center justify-between"><span className="text-ink-soft">Businesses scanned</span><span className="font-semibold">{scope === "area" ? quote.competitorCount + 1 : 1}</span></div>
            <div className="mt-1 flex items-center justify-between"><span className="text-ink-soft">Cost</span><span className="font-bold text-brand-deep">{quote.quote} credits</span></div>
            <div className="mt-1 flex items-center justify-between"><span className="text-ink-soft">Your balance</span><span className={quote.needsCredits ? "font-semibold text-trust-low" : "font-semibold"}>{quote.balance} credits</span></div>
          </div>
        )}

        <div className="mt-4 flex justify-end gap-2">
          {!quote ? (
            <button onClick={getQuote} disabled={phase === "quoting"} className="btn btn-primary px-5 py-2.5 text-sm disabled:opacity-60">
              {phase === "quoting" ? "Pricing…" : "Get quote"}
            </button>
          ) : quote.needsCredits ? (
            <a href="/billing" className="btn btn-primary px-5 py-2.5 text-sm">Buy credits →</a>
          ) : (
            <button onClick={confirm} disabled={phase === "running"} className="btn btn-primary px-5 py-2.5 text-sm disabled:opacity-60">
              {phase === "running" ? "Starting…" : `Run deep read · ${quote.quote} cr`}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

function ScopeCard({ active, onClick, title, desc }: { active: boolean; onClick: () => void; title: string; desc: string }) {
  return (
    <button onClick={onClick} className={`rounded-2xl border p-3 text-left transition-colors ${active ? "border-brand bg-brand-soft/60" : "border-line/60 bg-white/40 hover:bg-white/70"}`}>
      <div className="text-sm font-semibold text-ink">{title}</div>
      <div className="mt-0.5 text-[11px] text-ink-faint">{desc}</div>
    </button>
  );
}

function ResultRow({ r, rank, onMonitor, onDeep }: { r: ExploreResult; rank: number; onMonitor: () => void; onDeep: () => void }) {
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
      <div className="flex shrink-0 flex-col gap-1">
        <button onClick={onDeep} className="btn btn-primary px-3 py-1.5 text-xs" title="Pay to pull this business's full profile — reviews, social, deals & pricing">🔬 Deep read</button>
        <button onClick={onMonitor} className="btn btn-secondary px-3 py-1.5 text-xs" title="Track this business + its competitors, ongoing">Monitor →</button>
      </div>
    </li>
  );
}
