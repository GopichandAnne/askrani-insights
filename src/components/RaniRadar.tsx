"use client";

import { useEffect, useRef, useState } from "react";
import { RaniMark } from "@/components/RaniSpinner";
import type { CollectNode } from "@/components/RaniCollecting";

/**
 * The "moment" collection visual — a local-market radar. Rani at center, a teal
 * sweep rotating over the dark dial, each competitor a blip that pings while it's
 * being scraped and locks with a glow when done. Blip states are the REAL
 * per-business job status; the sweep is decorative. Used for the big moments
 * (onboarding first scan, deep-read); the node-track is the everyday banner.
 * Respects prefers-reduced-motion.
 */
export function RaniRadar({ businesses, done, total, allDone }: { businesses: CollectNode[]; done: number; total: number; allDone: boolean }) {
  const sweepRef = useRef<HTMLDivElement>(null);
  const [reduced, setReduced] = useState(false);

  useEffect(() => {
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    setReduced(mq.matches);
    if (mq.matches) return;
    let raf = 0;
    const start = performance.now();
    const loop = (t: number) => {
      const a = (((t - start) / 3600) * 360) % 360;
      if (sweepRef.current) sweepRef.current.style.transform = `rotate(${a}deg)`;
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, []);

  // You are at the center (Rani); competitors are the blips placed at their REAL
  // bearing + distance from you when geo is available, else evenly distributed.
  const target = businesses.find((b) => b.isTarget);
  const center = target && target.lat != null && target.lng != null ? { lat: target.lat, lng: target.lng } : null;
  const blips = businesses.some((b) => b.isTarget) ? businesses.filter((b) => !b.isTarget) : businesses;

  // equirectangular offset (deg) — fine for a local market; only ratios matter
  const off = (b: CollectNode) => center && b.lat != null && b.lng != null
    ? { north: b.lat - center.lat, east: (b.lng - center.lng) * Math.cos((center.lat * Math.PI) / 180) }
    : null;
  const geoBlips = blips.map(off).filter((o): o is { north: number; east: number } => !!o);
  const maxD = Math.max(1e-9, ...geoBlips.map((o) => Math.hypot(o.north, o.east)));
  const rings = [0.56, 0.82, 0.68];
  const place = (b: CollectNode, i: number) => {
    const o = off(b);
    if (o && (o.north !== 0 || o.east !== 0)) {
      const bearing = Math.atan2(o.east, o.north); // 0 = due north
      const screen = bearing - Math.PI / 2;        // rotate so north = top
      const r = (0.34 + 0.58 * (Math.hypot(o.north, o.east) / maxD)) * 44; // nearest→center, farthest→edge
      return { left: 50 + r * Math.cos(screen), top: 50 + r * Math.sin(screen) };
    }
    // no geo → even fallback slot
    const ang = (i * (360 / Math.max(1, blips.length)) - 90) * (Math.PI / 180);
    return { left: 50 + rings[i % rings.length] * 44 * Math.cos(ang), top: 50 + rings[i % rings.length] * 44 * Math.sin(ang) };
  };
  const activeName = businesses.find((b) => b.status === "running")?.name;
  const recent = businesses.filter((b) => b.status === "done" || b.status === "error").slice(-2).reverse();

  return (
    <div className="mt-2">
      <div className="relative mx-auto aspect-square w-full" style={{ maxWidth: 260 }}>
        {/* dark dial */}
        <div
          className="absolute inset-0 overflow-hidden rounded-full"
          style={{
            background: "radial-gradient(120% 120% at 50% 45%, #0f3b39 0%, #0a2430 55%, #06131c 100%)",
            boxShadow: "0 0 0 1px rgba(20,184,166,.25), 0 14px 40px -12px rgba(15,118,110,.45), inset 0 0 50px rgba(6,19,28,.6)",
          }}
        >
          {/* range rings */}
          {[0.4, 0.7, 1.0].map((f, i) => (
            <span key={i} className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 rounded-full" style={{ width: `${f * 92}%`, height: `${f * 92}%`, border: "1px solid rgba(94,234,212,.15)" }} />
          ))}
          {/* rotating sweep */}
          <div
            ref={sweepRef}
            className="absolute inset-0 rounded-full"
            style={{ background: "conic-gradient(from 0deg at 50% 50%, rgba(20,184,166,.38) 0deg, rgba(20,184,166,.1) 26deg, transparent 60deg, transparent 360deg)", willChange: "transform" }}
            aria-hidden
          />
          {/* competitor blips */}
          {blips.map((b, i) => {
            const doneish = b.status === "done" || b.status === "error";
            const running = b.status === "running";
            const { left, top } = place(b, i);
            return (
              <span
                key={i}
                className="absolute -translate-x-1/2 -translate-y-1/2 rounded-full"
                style={{
                  left: `${left}%`, top: `${top}%`, width: 11, height: 11,
                  background: doneish ? "#14b8a6" : running ? "#5eead4" : "rgba(94,234,212,.28)",
                  boxShadow: doneish ? "0 0 9px 1px rgba(20,184,166,.8)" : running ? "0 0 13px 3px rgba(94,234,212,.9)" : "none",
                  transition: "background .3s, box-shadow .3s",
                }}
                title={`${b.name}${running ? " · collecting…" : doneish ? " · done" : " · queued"}`}
              >
                {running && !reduced && <span className="absolute inset-[-4px] animate-ping rounded-full" style={{ border: "2px solid #5eead4" }} aria-hidden />}
                {running && (
                  <span className="absolute left-1/2 top-[14px] -translate-x-1/2 whitespace-nowrap rounded-md px-1.5 py-px text-[9px] font-bold" style={{ color: "#eafffb", background: "rgba(6,19,28,.75)", border: "1px solid rgba(94,234,212,.3)" }}>{b.name}</span>
                )}
              </span>
            );
          })}
          {/* Rani at center */}
          <span className="absolute left-1/2 top-1/2 grid -translate-x-1/2 -translate-y-1/2 place-items-center">
            <span className="absolute rounded-full" style={{ width: 52, height: 52, background: "rgba(20,184,166,.18)", filter: "blur(6px)" }} aria-hidden />
            {!reduced && <span className="absolute animate-ping rounded-full" style={{ width: 38, height: 38, border: "1.5px solid rgba(94,234,212,.5)" }} aria-hidden />}
            <span className={reduced ? "relative" : "relative animate-bob"}><RaniMark size={30} /></span>
          </span>
        </div>
      </div>

      {/* status + count */}
      <div className="mt-2 flex items-center justify-between gap-3">
        <p className="min-w-0 flex-1 truncate text-xs text-ink-soft">
          {allDone ? (
            <span className="font-medium text-brand-deep">✓ Rani scanned your whole market.</span>
          ) : activeName ? (
            <>Gathering intel from <span className="font-medium text-ink">{activeName}</span>…</>
          ) : (
            "Sweeping your neighborhood…"
          )}
        </p>
        <span className="shrink-0 text-xs font-semibold text-brand-deep" style={{ fontVariantNumeric: "tabular-nums" }}>{done}/{total}</span>
      </div>
      {recent.length > 0 && !allDone && (
        <div className="mt-1 flex flex-wrap gap-1.5">
          {recent.map((b, i) => (
            <span key={i} className="rounded-full bg-brand-soft px-2 py-0.5 text-[10px] font-medium text-brand-deep">✓ {b.name}</span>
          ))}
        </div>
      )}
    </div>
  );
}
