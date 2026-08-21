"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { RaniCollecting, type CollectNode } from "@/components/RaniCollecting";

/**
 * Full-page "we're gathering your signals" state, shown on a pillar while its
 * workspace is actively collecting — so the user sees clear PROGRESS (which
 * businesses, how many done) instead of an ambiguous spinner or a report built
 * from half-collected data. Polls the same status endpoint the banner uses and
 * auto-refreshes into the real pillar the moment collection finishes.
 */
export function CollectingScreen({ workspaceId, title }: { workspaceId: string; title: string }) {
  const router = useRouter();
  const [nodes, setNodes] = useState<CollectNode[] | null>(null);
  const finished = useRef(false);

  useEffect(() => {
    let stopped = false;
    const poll = async () => {
      try {
        const r = await fetch(`/api/collect/status?workspaceId=${workspaceId}`, { cache: "no-store" });
        if (!r.ok) return;
        const d = await r.json();
        // deno-lint-ignore no-explicit-any
        const js = ((d.jobs ?? []) as any[]).map((j) => ({
          name: j.name ?? "A business",
          status: (["pending", "running", "done", "error"].includes(j.status) ? j.status : "pending") as CollectNode["status"],
          lat: j.lat ?? null, lng: j.lng ?? null, isTarget: j.isTarget,
        }));
        if (!stopped) setNodes(js);
        const active = js.some((j) => j.status === "pending" || j.status === "running");
        if (!active && js.length && !finished.current) {
          finished.current = true; // collection done → load the now-ready pillar
          setTimeout(() => { if (!stopped) router.refresh(); }, 1800);
        }
      } catch { /* transient */ }
    };
    poll();
    const t = setInterval(poll, 4000);
    return () => { stopped = true; clearInterval(t); };
  }, [workspaceId, router]);

  const done = (nodes ?? []).filter((b) => b.status === "done" || b.status === "error").length;
  const total = (nodes ?? []).length;
  const allDone = total > 0 && done >= total;

  return (
    <div className="animate-fade-in space-y-6">
      <div>
        <p className="text-sm font-medium text-brand-deep">Ask Rani Insights</p>
        <h1 className="mt-1 font-display text-3xl font-extrabold tracking-tight">{title}</h1>
      </div>
      <section className="glass-strong rounded-3xl p-5">
        <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-brand-deep">
          <span aria-hidden>🛰️</span> {allDone ? "Wrapping up your market read…" : "Gathering your market signals"}
        </div>
        {nodes ? (
          <RaniCollecting businesses={nodes} done={done} total={total} allDone={allDone} />
        ) : (
          <div className="mt-4 flex items-center gap-3"><span className="rani-dots" aria-hidden><span /><span /><span /></span><span className="text-sm text-ink-faint">Starting the scan…</span></div>
        )}
        <p className="mt-3 max-w-xl text-sm text-ink-soft">
          Rani is pulling <b className="text-ink">reviews, ratings, prices, promotions and social posts</b> across {total || "your"} {total === 1 ? "business" : "businesses"}. This usually takes a couple of minutes — feel free to leave and come back, it keeps running. <b className="text-ink">This page updates automatically</b> the moment it&apos;s ready.
        </p>
      </section>
    </div>
  );
}
