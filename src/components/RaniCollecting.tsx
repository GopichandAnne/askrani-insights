"use client";

import { RaniMark } from "@/components/RaniSpinner";

/**
 * "Rani running across your competitors" — a live, delightful representation of
 * collection in progress. Each business is a node on a track; done nodes get a
 * teal check, the one being scraped pulses, and Rani glides to it and bobs while
 * she "gathers intel." Driven by the real per-business job status, so it mirrors
 * exactly what's happening. Respects prefers-reduced-motion.
 */
export interface CollectNode { name: string; status: "pending" | "running" | "done" | "error" }

export function RaniCollecting({ businesses, done, total, allDone }: { businesses: CollectNode[]; done: number; total: number; allDone: boolean }) {
  const n = businesses.length;
  const pos = (i: number) => (n <= 1 ? 50 : (i / (n - 1)) * 100);
  const runningIdx = businesses.findIndex((b) => b.status === "running");
  const activeIdx = allDone ? n - 1 : runningIdx >= 0 ? runningIdx : Math.min(done, Math.max(0, n - 1));
  const activeName = businesses[activeIdx]?.name;
  const pct = total ? Math.round((done / total) * 100) : 0;

  return (
    <div className="mt-3">
      {/* the track — one 0–100% coordinate space shared by nodes, fill, and Rani.
          The card's own padding gives the -translate-x-1/2 edge marks room. */}
      <div className="relative h-16 w-full">
        {/* baseline + progress fill */}
        <div className="absolute inset-x-0 top-[46px] h-0.5 rounded-full bg-line" aria-hidden />
        <div className="absolute left-0 top-[46px] h-0.5 rounded-full bg-brand-gradient transition-all duration-700" style={{ width: `${pct}%` }} aria-hidden />

        {/* competitor nodes */}
        {businesses.map((b, i) => {
          const doneish = b.status === "done" || b.status === "error";
          const running = b.status === "running";
          return (
            <span
              key={i}
              className={`absolute grid h-4 w-4 -translate-x-1/2 place-items-center rounded-full text-[8px] font-bold ${
                doneish ? "bg-brand text-white shadow-brand" : running ? "bg-white ring-2 ring-brand" : "bg-surface-sunken text-ink-faint ring-1 ring-line"
              }`}
              style={{ left: `${pos(i)}%`, top: "38px" }}
              title={`${b.name}${running ? " · collecting…" : doneish ? " · done" : " · queued"}`}
            >
              {running && <span className="absolute inset-0 animate-ping rounded-full bg-brand/40" aria-hidden />}
              {doneish ? "✓" : ""}
            </span>
          );
        })}

        {/* Rani gliding to the active node, bobbing while she gathers */}
        <div className="rani-run absolute flex -translate-x-1/2 flex-col items-center" style={{ left: `${pos(activeIdx)}%`, top: "2px" }} aria-hidden>
          <span className={allDone ? "block" : "block animate-bob"}>
            <RaniMark size={26} />
          </span>
          {!allDone && <span className="mt-0.5 block h-2.5 w-px bg-brand/50" />}
        </div>
      </div>

      {/* label + count */}
      <div className="mt-1 flex items-center justify-between gap-3">
        <p className="min-w-0 flex-1 truncate text-xs text-ink-soft">
          {allDone ? (
            <span className="font-medium text-brand-deep">✓ Rani gathered intel across your market.</span>
          ) : activeName ? (
            <>Rani is gathering intel from <span className="font-medium text-ink">{activeName}</span>…</>
          ) : (
            "Rani is starting the scan…"
          )}
        </p>
        <span className="shrink-0 text-xs font-semibold text-brand-deep" style={{ fontVariantNumeric: "tabular-nums" }}>{done}/{total}</span>
      </div>
    </div>
  );
}
