import type { MetricScore } from "@/lib/scorecard";

/**
 * The "You vs Your Market" hero — concentric activity rings, one per metric
 * (outer→inner). Filled arc = you, tick = market average, gold dot = the category
 * leader. Arc past the dot → you beat the best; arc short of the tick → behind the
 * market. Pure/server-rendered from the scorecard scores. The composite score sits
 * in the centre; the "position score / 100" caption goes BELOW the chart (in the page).
 */

const RING_R = [108, 89, 70, 51]; // outer → inner, matches metric order
const COLORS: Record<MetricScore["color"], string> = {
  amber: "#d9930a", green: "#12a06f", violet: "#6366f1", teal: "#0d9488",
};
const AVG = "#64748b", BEST = "#eab308", INK = "#16211d";

const pt = (r: number, f: number): [number, number] => {
  const a = (-90 + 360 * f) * (Math.PI / 180);
  return [130 + r * Math.cos(a), 130 + r * Math.sin(a)];
};

export function ScoreRings({ metrics, score }: { metrics: MetricScore[]; score: number | null }) {
  return (
    <svg viewBox="0 0 260 260" width="100%" style={{ maxWidth: 320, display: "block", margin: "0 auto" }} role="img" aria-label="competitive scorecard rings">
      {/* background rings */}
      <g fill="none" strokeWidth={12}>
        {metrics.map((m, i) => <circle key={i} cx={130} cy={130} r={RING_R[i]} stroke={COLORS[m.color]} opacity={0.13} />)}
      </g>
      {/* your arcs */}
      <g fill="none" strokeWidth={12} strokeLinecap="round" transform="rotate(-90 130 130)">
        {metrics.map((m, i) => {
          if (m.you == null) return null;
          const r = RING_R[i], C = 2 * Math.PI * r, f = Math.max(0.004, Math.min(1, m.you / 100));
          return <circle key={i} cx={130} cy={130} r={r} stroke={COLORS[m.color]} strokeDasharray={`${(f * C).toFixed(1)} ${C.toFixed(1)}`} />;
        })}
      </g>
      {/* market-average ticks */}
      <g stroke={AVG} strokeWidth={2.5} strokeLinecap="round" opacity={0.9}>
        {metrics.map((m, i) => {
          if (m.avg == null) return null;
          const r = RING_R[i], f = m.avg / 100, [x1, y1] = pt(r - 7, f), [x2, y2] = pt(r + 7, f);
          return <line key={i} x1={x1} y1={y1} x2={x2} y2={y2} />;
        })}
      </g>
      {/* leader dots */}
      <g fill={BEST} stroke="#ffffff" strokeWidth={2}>
        {metrics.map((m, i) => {
          if (m.best == null) return null;
          const [x, y] = pt(RING_R[i], m.best / 100);
          return <circle key={i} cx={x} cy={y} r={4} />;
        })}
      </g>
      {/* centre composite */}
      <text x={130} y={144} textAnchor="middle" fontFamily="'Inter Tight', ui-sans-serif, system-ui, sans-serif" fontSize={40} fontWeight={800} fill={INK}>
        {score ?? "—"}
      </text>
    </svg>
  );
}
