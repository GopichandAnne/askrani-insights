/**
 * Tiny inline-SVG sparkline for a score-over-time series (e.g. the Findability
 * trend). Pure + theme-aware: the line uses currentColor, so the caller's text
 * color class (trust-direct when rising, trust-low when falling) drives it in both
 * light and dark. Renders nothing with fewer than 2 points.
 */
export function Sparkline({ points, width = 128, height = 36 }: { points: number[]; width?: number; height?: number }) {
  if (!points || points.length < 2) return null;
  const min = Math.min(...points);
  const max = Math.max(...points);
  const span = max - min || 1;
  const stepX = width / (points.length - 1);
  const pad = 3;
  const y = (v: number) => height - pad - ((v - min) / span) * (height - pad * 2);
  const d = points.map((v, i) => `${i ? "L" : "M"}${(i * stepX).toFixed(1)},${y(v).toFixed(1)}`).join(" ");
  const rising = points[points.length - 1] >= points[0];
  return (
    <svg
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      className={`overflow-visible ${rising ? "text-trust-direct" : "text-trust-low"}`}
      role="img"
      aria-label={`Trend from ${points[0]} to ${points[points.length - 1]}`}
    >
      <path d={d} fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
      <circle cx={(width).toFixed(1)} cy={y(points[points.length - 1]).toFixed(1)} r="2.6" fill="currentColor" />
    </svg>
  );
}
