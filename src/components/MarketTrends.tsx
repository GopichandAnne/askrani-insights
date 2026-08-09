import type { MarketTrends as Trends, TrendPoint } from "@/lib/panel";

/**
 * Phase-2 over-time view of the market panel. With <2 snapshot days it shows the
 * current standing as stat tiles (the honest form for a single point); once the
 * panel has accumulated ≥2 days it renders you-vs-market line charts. Colors from
 * the app system: teal = you (the entity of interest), muted grey = the market
 * baseline; area fill under you, emphasized endpoint, legend, tabular numerals.
 */

const TEAL = "#0f766e", TEAL_FILL = "#14b8a6", MKT = "#9ca3af", GRID = "#e5e7eb";

export function MarketTrends({ trends }: { trends: Trends }) {
  const { points, latest, days } = trends;
  if (!latest) return null;

  return (
    <section className="card">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="flex items-center gap-2 font-semibold">
          <span className="grid h-7 w-7 place-items-center rounded-lg bg-brand-gradient text-white shadow-brand">📈</span>
          How you&apos;re tracking over time
        </h2>
        <span className="text-[11px] text-ink-faint">{days} snapshot{days === 1 ? "" : "s"} · updates each scan</span>
      </div>

      {days < 2 ? (
        <>
          <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <StatTile label="Your rating" value={fmtStar(latest.youRating)} sub={latest.mktRating != null ? `market ${fmtStar(latest.mktRating)}` : undefined} good={cmp(latest.youRating, latest.mktRating)} />
            <StatTile label="Rank in market" value={latest.rank != null ? `#${latest.rank}` : "—"} sub={latest.marketSize != null ? `of ${latest.marketSize}` : undefined} />
            <StatTile label="Your avg price" value={fmtUsd(latest.youPrice)} sub={latest.mktPrice != null ? `market ${fmtUsd(latest.mktPrice)}` : undefined} />
            <StatTile label="Your activity" value={`${latest.deals ?? 0} deals`} sub={`${latest.ads ?? 0} ads running`} />
          </div>
          <p className="mt-3 text-xs text-ink-faint">
            Trend lines appear here as we snapshot your market each scan — check back after the next weekly refresh to see the movement.
          </p>
        </>
      ) : (
        <>
          <div className="mt-4 grid gap-5 sm:grid-cols-2">
            <LineChart title="Rating — you vs market" dates={points.map((p) => p.date)}
              series={[
                { label: "You", color: TEAL, fill: true, values: points.map((p) => p.youRating) },
                { label: "Market", color: MKT, dashed: true, values: points.map((p) => p.mktRating) },
              ]} fmt={(v) => `${v.toFixed(1)}★`} />
            <LineChart title="Avg price — you vs market" dates={points.map((p) => p.date)}
              series={[
                { label: "You", color: TEAL, fill: true, values: points.map((p) => p.youPrice) },
                { label: "Market", color: MKT, dashed: true, values: points.map((p) => p.mktPrice) },
              ]} fmt={(v) => `$${v.toFixed(0)}`} />
          </div>
          <div className="mt-4 grid gap-3 sm:grid-cols-3">
            <StatTile label="Rank in market" value={latest.rank != null ? `#${latest.rank}` : "—"} sub={latest.marketSize != null ? `of ${latest.marketSize}` : undefined} delta={deltaRank(points)} />
            <StatTile label="Your deals live" value={String(latest.deals ?? 0)} delta={deltaNum(points, "deals")} />
            <StatTile label="Your ads running" value={String(latest.ads ?? 0)} delta={deltaNum(points, "ads")} />
          </div>
        </>
      )}
    </section>
  );
}

/* ── SVG line chart (server-rendered, no external lib) ───────────────────────── */
interface Series { label: string; color: string; values: (number | null)[]; dashed?: boolean; fill?: boolean }

function LineChart({ title, dates, series, fmt }: { title: string; dates: string[]; series: Series[]; fmt: (v: number) => string }) {
  const all = series.flatMap((s) => s.values).filter((v): v is number => typeof v === "number");
  if (all.length < 2) return null;
  const W = 320, H = 120, padX = 10, padTop = 14, padBot = 22;
  const n = dates.length;
  const min = Math.min(...all), max = Math.max(...all);
  const xOf = (i: number) => padX + (n <= 1 ? 0 : (i * (W - 2 * padX)) / (n - 1));
  const yOf = (v: number) => (max === min ? (padTop + (H - padBot)) / 2 : H - padBot - ((v - min) / (max - min)) * (H - padTop - padBot));
  const path = (vals: (number | null)[]) => vals.map((v, i) => (v == null ? null : `${i === 0 || vals[i - 1] == null ? "M" : "L"}${xOf(i).toFixed(1)},${yOf(v).toFixed(1)}`)).filter(Boolean).join(" ");
  const lastIdx = (vals: (number | null)[]) => { for (let i = vals.length - 1; i >= 0; i--) if (vals[i] != null) return i; return -1; };
  const fmtDate = (d: string) => new Date(d + "T00:00:00").toLocaleDateString(undefined, { month: "short", day: "numeric" });

  return (
    <figure className="m-0">
      <figcaption className="mb-1 text-xs font-semibold text-ink-soft">{title}</figcaption>
      <svg viewBox={`0 0 ${W} ${H}`} width="100%" role="img" aria-label={title} style={{ display: "block" }}>
        {/* recessive baseline grid: min + max */}
        {[min, max].map((v, k) => (
          <g key={k}>
            <line x1={padX} x2={W - padX} y1={yOf(v)} y2={yOf(v)} stroke={GRID} strokeWidth="1" />
            <text x={W - padX} y={yOf(v) - 2} textAnchor="end" fontSize="8" fill="#9ca3af" style={{ fontVariantNumeric: "tabular-nums" }}>{fmt(v)}</text>
          </g>
        ))}
        {series.map((s, si) => {
          const li = lastIdx(s.values);
          const d = path(s.values);
          if (!d) return null;
          return (
            <g key={si}>
              {s.fill && (
                <path d={`${d} L${xOf(li).toFixed(1)},${(H - padBot).toFixed(1)} L${xOf(s.values.findIndex((v) => v != null)).toFixed(1)},${(H - padBot).toFixed(1)} Z`} fill={TEAL_FILL} opacity="0.12" />
              )}
              <path d={d} fill="none" stroke={s.color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" strokeDasharray={s.dashed ? "4 3" : undefined} />
              {li >= 0 && s.values[li] != null && (
                <>
                  <circle cx={xOf(li)} cy={yOf(s.values[li]!)} r="3.5" fill={s.color} stroke="#fff" strokeWidth="2" />
                  <text x={xOf(li) - 6} y={yOf(s.values[li]!) - 6} textAnchor="end" fontSize="9" fontWeight="700" fill={si === 0 ? TEAL : "#6b7280"} style={{ fontVariantNumeric: "tabular-nums" }}>{fmt(s.values[li]!)}</text>
                </>
              )}
            </g>
          );
        })}
        {/* x range labels */}
        <text x={padX} y={H - 6} fontSize="8" fill="#9ca3af">{fmtDate(dates[0])}</text>
        <text x={W - padX} y={H - 6} textAnchor="end" fontSize="8" fill="#9ca3af">{fmtDate(dates[dates.length - 1])}</text>
      </svg>
      {/* legend (2 series → always present; identity not color-alone) */}
      <div className="mt-1 flex items-center gap-3 text-[11px] text-ink-faint">
        {series.map((s, i) => (
          <span key={i} className="inline-flex items-center gap-1.5">
            <span style={{ width: 14, height: 0, borderTop: `2px ${s.dashed ? "dashed" : "solid"} ${s.color}`, display: "inline-block" }} />
            {s.label}
          </span>
        ))}
      </div>
    </figure>
  );
}

function StatTile({ label, value, sub, good, delta }: { label: string; value: string; sub?: string; good?: boolean | null; delta?: string | null }) {
  return (
    <div className="rounded-2xl bg-white/55 p-3">
      <div className="text-[11px] font-semibold uppercase tracking-wide text-ink-faint">{label}</div>
      <div className="mt-0.5 flex items-baseline gap-2">
        <span className={`font-display text-xl font-extrabold ${good === true ? "text-brand-deep" : good === false ? "text-coral-dark" : "text-ink"}`} style={{ fontVariantNumeric: "tabular-nums" }}>{value}</span>
        {delta && <span className="text-[11px] font-medium text-ink-faint">{delta}</span>}
      </div>
      {sub && <div className="text-xs text-ink-faint">{sub}</div>}
    </div>
  );
}

const fmtStar = (v: number | null) => (v != null ? `${v.toFixed(1)}★` : "—");
const fmtUsd = (v: number | null) => (v != null ? `$${v.toFixed(0)}` : "—");
const cmp = (a: number | null, b: number | null) => (a == null || b == null ? null : a >= b);
function deltaRank(points: TrendPoint[]): string | null {
  const r = points.map((p) => p.rank).filter((v): v is number => v != null);
  if (r.length < 2) return null;
  const d = r[0] - r[r.length - 1]; // rank down = better (moved up)
  return d === 0 ? "no change" : d > 0 ? `▲ up ${d}` : `▼ down ${-d}`;
}
function deltaNum(points: TrendPoint[], key: "deals" | "ads"): string | null {
  const v = points.map((p) => p[key]).filter((x): x is number => x != null);
  if (v.length < 2) return null;
  const d = v[v.length - 1] - v[0];
  return d === 0 ? "no change" : d > 0 ? `+${d}` : `${d}`;
}
