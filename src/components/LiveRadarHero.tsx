"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { RaniMark } from "@/components/RaniSpinner";

/**
 * The signed-out hero — the product doing its job, live, on load. A dark
 * market-radar sweeps and lights up nearby competitors; a glass card turns one
 * live signal into one move. Seeded with a demo market, then swaps to the
 * visitor's REAL nearby businesses the moment they type an area (same /api/explore
 * the free tool below uses). Story carries the pitch — the copy stays 5 words.
 * Respects prefers-reduced-motion. Blip placement mirrors RaniRadar's geo math.
 */

type Blip = { name: string; left: number; top: number; angle: number; hot?: boolean };
type Story = { tag: string; who: string; sig: string; act: string };

// Shared radar layout (7 slots) — every demo market reuses it, so only the names
// and stories change as we rotate through verticals.
const LAYOUT: { angle: number; r: number }[] = [
  { angle: 32, r: 0.42 }, { angle: 112, r: 0.63 }, { angle: 210, r: 0.55 }, { angle: 168, r: 0.78 },
  { angle: 300, r: 0.7 }, { angle: 342, r: 0.9 }, { angle: 78, r: 0.85 },
];
function buildBlips(names: { name: string; hot?: boolean }[]): Blip[] {
  return names.map((b, i) => {
    const { angle, r } = LAYOUT[i % LAYOUT.length];
    const a = (angle - 90) * (Math.PI / 180);
    return { name: b.name, hot: b.hot, angle, left: 50 + r * 44 * Math.cos(a), top: 50 + r * 44 * Math.sin(a) };
  });
}

// Demo markets — rotate through verticals so no single one (e.g. med spas) makes
// other owners feel the product isn't for them. Each carries its own blips + stories.
const MARKETS: { label: string; keyword: string; blips: Blip[]; stories: Story[] }[] = [
  {
    label: "med spas", keyword: "med spa",
    blips: buildBlips([{ name: "Radiance", hot: true }, { name: "Glow" }, { name: "Lush Skin" }, { name: "Bela" }, { name: "Rejuve" }, { name: "NovaDerm" }, { name: "Serene" }]),
    stories: [
      { tag: "price drop", who: "Radiance Med Spa", sig: "launched $10/unit Botox for new clients", act: "Match it with a first-visit offer — post before the weekend" },
      { tag: "review spike", who: "Glow Aesthetics", sig: "pulled 18 five-star reviews in two weeks", act: "Ask your last 10 happy clients for a review today" },
    ],
  },
  {
    label: "restaurants", keyword: "restaurant",
    blips: buildBlips([{ name: "Saffron", hot: true }, { name: "Nonna's" }, { name: "El Farol" }, { name: "Blue Oak" }, { name: "Pho 88" }, { name: "Tandoor" }, { name: "Verde" }]),
    stories: [
      { tag: "new deal", who: "Saffron Kitchen", sig: "added a $9 weekday lunch combo", act: "Run a lunch special of your own this week" },
      { tag: "hit post", who: "Blue Oak BBQ", sig: "a brisket reel got 5× their usual reach", act: "Post a short cook video of your best dish" },
    ],
  },
  {
    label: "barbers", keyword: "barber",
    blips: buildBlips([{ name: "Fade Co", hot: true }, { name: "The Chair" }, { name: "Gloss" }, { name: "Sharp" }, { name: "Mane" }, { name: "Blowout" }, { name: "Lux" }]),
    stories: [
      { tag: "promo", who: "Fade Co", sig: "dropped $20 weekend fades for new clients", act: "Offer a first-visit discount and post it Friday" },
      { tag: "hit post", who: "Gloss Bar", sig: "a color transformation reel blew up", act: "Post a before/after of your best cut this week" },
    ],
  },
  {
    label: "grocers", keyword: "grocery",
    blips: buildBlips([{ name: "Patel Bros", hot: true }, { name: "Fresh Mart" }, { name: "Namaste" }, { name: "Sabzi" }, { name: "Green Cart" }, { name: "H-Town" }, { name: "Daily" }]),
    stories: [
      { tag: "sale", who: "Patel Brothers", sig: "ran a mango case sale this weekend", act: "Feature a seasonal produce deal up front" },
      { tag: "flyer", who: "Fresh Mart", sig: "their weekly flyer post hit 4× reach", act: "Post your weekly specials as a simple flyer" },
    ],
  },
];

interface LiveResult { name: string; rating: number | null; reviews: number | null; geo?: { lat: number; lng: number }; distanceKm?: number }

export function LiveRadarHero() {
  const [area, setArea] = useState("");
  const [keyword, setKeyword] = useState("");
  const [mode, setMode] = useState<"demo" | "live">("demo");
  const [loading, setLoading] = useState(false);
  const [marketIdx, setMarketIdx] = useState(0);
  const [blips, setBlips] = useState<Blip[]>(MARKETS[0].blips);
  const [summary, setSummary] = useState<{ n: number; avg: number | null; leader: string | null; leaderRating: number | null; label: string } | null>(null);
  const [storyIdx, setStoryIdx] = useState(0);
  const [reduced, setReduced] = useState(false);

  const sweepRef = useRef<HTMLDivElement>(null);
  const blipRefs = useRef<(HTMLSpanElement | null)[]>([]);
  const litRef = useRef<Set<number>>(new Set());

  // sweep + "beam lights the blip as it passes" — direct DOM writes, no re-render
  useEffect(() => {
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    setReduced(mq.matches);
    litRef.current = new Set();
    if (mq.matches) {
      blips.forEach((_, i) => lock(i, blips[i].hot));
      return;
    }
    let raf = 0;
    const start = performance.now();
    const loop = (t: number) => {
      const ang = (((t - start) / 3600) * 360) % 360;
      if (sweepRef.current) sweepRef.current.style.transform = `rotate(${ang}deg)`;
      blips.forEach((b, i) => {
        if (litRef.current.has(i)) return;
        const diff = ((ang - b.angle + 360) % 360);
        if (diff < 14) { litRef.current.add(i); lock(i, b.hot); }
      });
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [blips]);

  function lock(i: number, hot?: boolean) {
    const el = blipRefs.current[i];
    if (!el) return;
    el.style.background = hot ? "#fb7185" : "#14b8a6";
    el.style.boxShadow = hot ? "0 0 12px 2px rgba(251,113,133,.85)" : "0 0 9px 1px rgba(20,184,166,.8)";
    const ping = el.querySelector<HTMLSpanElement>("[data-ping]");
    const lbl = el.querySelector<HTMLSpanElement>("[data-lbl]");
    if (ping && !reduced) { ping.style.animation = "none"; void ping.offsetWidth; ping.style.animation = "radar-ping 1s ease-out 1"; }
    if (lbl) lbl.style.opacity = "0.95";
  }

  // in demo mode, re-seed the radar to the current vertical's businesses
  useEffect(() => {
    if (mode === "demo") setBlips(MARKETS[marketIdx].blips);
  }, [mode, marketIdx]);

  // demo cycling — advance stories, then roll to the next vertical when a market's
  // stories are spent, so the hero shows med spas → restaurants → barbers → grocers.
  useEffect(() => {
    if (mode !== "demo" || reduced) return;
    const stories = MARKETS[marketIdx].stories;
    const t = setInterval(() => {
      setStoryIdx((i) => {
        if (i + 1 < stories.length) return i + 1;
        setMarketIdx((m) => (m + 1) % MARKETS.length);
        return 0;
      });
    }, 3200);
    return () => clearInterval(t);
  }, [mode, reduced, marketIdx]);

  async function scan(e: React.FormEvent) {
    e.preventDefault();
    if (area.trim().length < 2 || loading) return;
    setLoading(true);
    try {
      const r = await fetch("/api/explore", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ area: area.trim(), keyword: keyword.trim() }) });
      const d = await r.json();
      const results: LiveResult[] = (d.results ?? []).slice(0, 8);
      const center = d.center as { lat: number; lng: number } | undefined;
      if (results.length) {
        setBlips(toBlips(results, center));
        const rated = results.filter((x) => typeof x.rating === "number");
        const avg = rated.length ? Number((rated.reduce((s, x) => s + (x.rating as number), 0) / rated.length).toFixed(1)) : null;
        const leader = [...results].sort((a, b) => (b.rating ?? 0) - (a.rating ?? 0))[0];
        setSummary({ n: (d.results ?? []).length, avg, leader: leader?.name ?? null, leaderRating: leader?.rating ?? null, label: area.trim() });
        setMode("live");
      }
    } catch { /* keep demo on failure */ } finally { setLoading(false); }
  }

  const market = MARKETS[marketIdx];
  const story = market.stories[storyIdx] ?? market.stories[0];

  return (
    <section className="mx-auto grid max-w-6xl items-center gap-10 px-6 py-12 lg:grid-cols-[1.05fr_0.95fr] lg:py-20">
      {/* left — minimal words */}
      <div>
        <span className="glass inline-flex items-center gap-2 rounded-full px-4 py-1.5 text-sm font-semibold text-brand-deep">
          <span className="rani-dots scale-75" aria-hidden><span /><span /><span /></span>
          Your always-on local market analyst
        </span>
        <h1 className="mt-6 font-display text-4xl font-extrabold leading-[1.05] tracking-tight sm:text-5xl lg:text-5xl">
          <span className="block whitespace-nowrap">Know your competition.</span>
          <span className="block text-gradient">Beat it.</span>
        </h1>
        <p className="mt-5 max-w-sm text-lg text-ink-soft">
          Rani watches every rival near you — and tells you the move to make.
        </p>
        <div className="mt-7 flex flex-wrap gap-3">
          <a href="#explore" className="btn btn-primary px-7 py-3.5 text-base">
            Scan my area — free <RaniMark size={18} />
          </a>
          <Link href="/login" className="btn btn-secondary px-7 py-3.5 text-base">Sign in</Link>
        </div>
        <p className="mt-4 text-sm text-ink-faint">Explore free · no card · monitoring runs on credits</p>
        <div className="mt-6 flex flex-wrap items-center gap-2">
          <span className="text-xs font-semibold uppercase tracking-wide text-ink-faint">Built for any small business</span>
          {["Restaurants", "Salons", "Med spas", "Grocers", "& more"].map((t) => (
            <span key={t} className="chip bg-white/70 text-ink-soft">{t}</span>
          ))}
        </div>
      </div>

      {/* right — the live radar that carries the story */}
      <div className="relative">
        <div className="relative overflow-hidden rounded-3xl border p-4 shadow-glass" style={{ borderColor: "rgba(45,212,191,.16)", background: "radial-gradient(120% 120% at 50% 15%, #0a3a38, #06201f)" }}>
          {/* header + real search */}
          <div className="flex items-center justify-between text-[12.5px] font-semibold" style={{ color: "#a7f3d0" }}>
            <span>◎ Rani scanning nearby</span>
            <span className="inline-flex items-center gap-1.5" style={{ color: "#5eead4" }}>
              <span className="inline-block h-1.5 w-1.5 rounded-full" style={{ background: "#5eead4", boxShadow: "0 0 8px #5eead4" }} />
              {mode === "live" ? "your market" : `live demo · ${market.label}`}
            </span>
          </div>
          <form onSubmit={scan} className="mt-2.5 flex gap-1.5">
            <input value={area} onChange={(e) => setArea(e.target.value)} placeholder="Your zip or city" aria-label="Your zip or city"
              className="min-w-0 flex-1 rounded-full px-3.5 py-2 text-sm text-white placeholder:text-teal-200/50 focus:outline-none focus:ring-2 focus:ring-teal-300/40"
              style={{ background: "rgba(6,19,28,.6)", border: "1px solid rgba(94,234,212,.28)" }} />
            <input value={keyword} onChange={(e) => setKeyword(e.target.value)} placeholder={mode === "demo" ? market.keyword : "med spa"} aria-label="What you do"
              className="hidden w-28 rounded-full px-3.5 py-2 text-sm text-white placeholder:text-teal-200/50 focus:outline-none focus:ring-2 focus:ring-teal-300/40 sm:block"
              style={{ background: "rgba(6,19,28,.6)", border: "1px solid rgba(94,234,212,.28)" }} />
            <button type="submit" disabled={loading} className="shrink-0 rounded-full px-4 py-2 text-sm font-bold text-teal-950 disabled:opacity-60" style={{ background: "linear-gradient(140deg,#5eead4,#14b8a6)" }}>
              {loading ? "…" : "Scan"}
            </button>
          </form>

          {/* dial */}
          <div className="relative mx-auto mt-3 aspect-square w-full" style={{ maxWidth: 300 }}>
            <div className="absolute inset-0 overflow-hidden rounded-full" style={{ background: "radial-gradient(120% 120% at 50% 45%, #0f3b39 0%, #0a2430 55%, #06131c 100%)", boxShadow: "0 0 0 1px rgba(20,184,166,.25), inset 0 0 50px rgba(6,19,28,.6)" }}>
              {/* a stylised night-map so it reads as "Rani scanning your neighbourhood" */}
              <svg viewBox="0 0 300 300" preserveAspectRatio="xMidYMid slice" className="map-drift absolute inset-0 h-full w-full" aria-hidden>
                <defs>
                  <radialGradient id="raniMap" cx="50%" cy="42%" r="75%">
                    <stop offset="0%" stopColor="#123f3c" />
                    <stop offset="55%" stopColor="#0b262c" />
                    <stop offset="100%" stopColor="#06131c" />
                  </radialGradient>
                </defs>
                <rect width="300" height="300" fill="url(#raniMap)" />
                <g fill="rgba(94,234,212,.05)">
                  <rect x="26" y="34" width="58" height="40" rx="4" /><rect x="96" y="30" width="52" height="46" rx="4" />
                  <rect x="212" y="44" width="60" height="40" rx="4" /><rect x="34" y="150" width="54" height="48" rx="4" />
                  <rect x="120" y="152" width="60" height="50" rx="4" /><rect x="30" y="228" width="66" height="42" rx="4" />
                  <rect x="210" y="214" width="60" height="56" rx="4" />
                </g>
                <rect x="196" y="150" width="56" height="44" rx="10" fill="rgba(52,211,153,.10)" />
                {/* main avenues — all through the centre (behind Rani) so they meet at one point */}
                <g stroke="rgba(125,211,197,.20)" strokeWidth="3.5" strokeLinecap="round">
                  <line x1="150" y1="0" x2="150" y2="300" /><line x1="0" y1="150" x2="300" y2="150" />
                  <line x1="0" y1="0" x2="300" y2="300" /><line x1="300" y1="0" x2="0" y2="300" />
                </g>
                <g stroke="rgba(125,211,197,.12)" strokeWidth="1.6">
                  <line x1="92" y1="0" x2="98" y2="300" /><line x1="210" y1="0" x2="206" y2="300" /><line x1="0" y1="86" x2="300" y2="80" /><line x1="0" y1="212" x2="300" y2="220" />
                </g>
              </svg>
              {[0.4, 0.7, 1.0].map((f, i) => (
                <span key={i} className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 rounded-full" style={{ width: `${f * 92}%`, height: `${f * 92}%`, border: "1px solid rgba(94,234,212,.15)" }} />
              ))}
              <div ref={sweepRef} className="absolute inset-0 rounded-full" aria-hidden style={{ background: "conic-gradient(from 0deg at 50% 50%, rgba(20,184,166,.38) 0deg, rgba(20,184,166,.1) 26deg, transparent 60deg, transparent 360deg)", willChange: "transform" }} />

              {blips.map((b, i) => (
                <span key={mode === "demo" ? `demo-${marketIdx}-${i}` : `live-${i}`} ref={(el) => { blipRefs.current[i] = el; }} className="absolute h-[11px] w-[11px] -translate-x-1/2 -translate-y-1/2 rounded-full"
                  style={{ left: `${b.left}%`, top: `${b.top}%`, background: "rgba(94,234,212,.28)", transition: "background .3s, box-shadow .3s" }} title={b.name}>
                  {!reduced && <span data-ping className="absolute inset-[-4px] rounded-full" style={{ border: "2px solid #5eead4", opacity: 0 }} aria-hidden />}
                  <span data-lbl className="absolute left-1/2 top-[13px] -translate-x-1/2 whitespace-nowrap rounded-md px-1.5 py-px text-[9px] font-bold opacity-0 transition-opacity" style={{ color: "#eafffb", background: "rgba(6,19,28,.75)", border: "1px solid rgba(94,234,212,.3)" }}>{b.name}</span>
                </span>
              ))}

              {/* Rani at center — she is the one scanning */}
              <span className="absolute left-1/2 top-1/2 grid -translate-x-1/2 -translate-y-1/2 place-items-center">
                <span className="absolute rounded-full" style={{ width: 108, height: 108, background: "rgba(20,184,166,.22)", filter: "blur(11px)" }} aria-hidden />
                {!reduced && <span className="absolute animate-ping rounded-full" style={{ width: 94, height: 94, border: "1.5px solid rgba(94,234,212,.45)" }} aria-hidden />}
                <span className={reduced ? "relative" : "relative animate-bob"}>
                  <img src="/rani-3d.png" alt="Rani" className="h-20 w-auto" style={{ filter: "drop-shadow(0 8px 14px rgba(0,0,0,.45))" }} />
                </span>
              </span>
            </div>
          </div>

          {/* payoff card: demo story → or real market read */}
          <div className="mt-3 rounded-2xl p-3.5" style={{ background: "rgba(255,255,255,.72)", backdropFilter: "blur(12px)", border: "1px solid rgba(255,255,255,.6)" }}>
            {mode === "demo" ? (
              <div className="animate-fade-in" key={`${marketIdx}-${storyIdx}`}>
                <div className="flex items-start gap-2">
                  <span className="shrink-0 rounded-full bg-coral/15 px-2 py-1 text-[10.5px] font-extrabold uppercase tracking-wide text-coral-dark">{story.tag}</span>
                  <span className="text-[13.5px] leading-snug text-ink"><b>{story.who}</b> {story.sig}</span>
                </div>
                <div className="mt-2 flex items-center gap-2">
                  <span className="shrink-0 rounded-full bg-brand-soft px-2 py-1 text-[10.5px] font-extrabold uppercase tracking-wide text-brand-deep">your move</span>
                  <span className="min-w-0 flex-1 text-[13.5px] font-semibold leading-snug text-brand-deep">{story.act}</span>
                  <span className="shrink-0 rounded-full border border-line bg-white/80 px-2.5 py-1 text-[11.5px] font-bold text-brand-deep">✍️ Draft</span>
                </div>
              </div>
            ) : (
              <div className="animate-fade-in">
                <div className="flex items-start gap-2">
                  <span className="shrink-0 rounded-full bg-brand-soft px-2 py-1 text-[10.5px] font-extrabold uppercase tracking-wide text-brand-deep">your market</span>
                  <span className="text-[13.5px] leading-snug text-ink">
                    <b>{summary?.n}</b> rivals near <b>{summary?.label}</b>
                    {summary?.avg != null && <> · avg <b>{summary.avg}★</b></>}
                    {summary?.leader && <> · leader <b>{summary.leader}</b>{summary.leaderRating != null && ` ${summary.leaderRating}★`}</>}
                  </span>
                </div>
                <div className="mt-2 flex items-center gap-2">
                  <span className="min-w-0 flex-1 text-[13px] leading-snug text-ink-soft">Rani would watch all {summary?.n} and send you one move a week.</span>
                  <a href="#explore" className="shrink-0 rounded-full bg-brand-gradient px-3 py-1.5 text-[11.5px] font-bold text-white">See the full read ↓</a>
                </div>
              </div>
            )}
          </div>
        </div>
        {/* aura glows */}
        <div className="pointer-events-none absolute -right-4 -top-6 h-24 w-24 rounded-full bg-coral/20 blur-2xl" aria-hidden />
        <div className="pointer-events-none absolute -bottom-8 left-2 h-28 w-28 rounded-full bg-brand/20 blur-2xl" aria-hidden />
      </div>
    </section>
  );
}

// Map real /api/explore results to radar blips using their true bearing+distance
// from the area centroid (same equirectangular approach as RaniRadar).
function toBlips(results: LiveResult[], center?: { lat: number; lng: number }): Blip[] {
  const withGeo = results.map((r) => ({ r, o: center && r.geo ? { north: r.geo.lat - center.lat, east: (r.geo.lng - center.lng) * Math.cos((center.lat * Math.PI) / 180) } : null }));
  const maxD = Math.max(1e-9, ...withGeo.map((x) => (x.o ? Math.hypot(x.o.north, x.o.east) : 0)));
  const rings = [0.5, 0.72, 0.62, 0.86, 0.94];
  return withGeo.map(({ r, o }, i) => {
    const short = r.name.split(/[\s,]/)[0];
    if (o && (o.north !== 0 || o.east !== 0)) {
      const bearing = Math.atan2(o.east, o.north) - Math.PI / 2;
      const rad = (0.34 + 0.58 * (Math.hypot(o.north, o.east) / maxD)) * 44;
      const angle = ((Math.atan2(o.east, o.north) * 180) / Math.PI + 360) % 360; // 0 = north/top, matches sweep
      return { name: short, left: 50 + rad * Math.cos(bearing), top: 50 + rad * Math.sin(bearing), angle, hot: i === 0 };
    }
    const a = (i * (360 / Math.max(1, results.length)) - 90) * (Math.PI / 180);
    const rr = rings[i % rings.length];
    return { name: short, left: 50 + rr * 44 * Math.cos(a), top: 50 + rr * 44 * Math.sin(a), angle: (i * (360 / Math.max(1, results.length))) % 360, hot: i === 0 };
  });
}
