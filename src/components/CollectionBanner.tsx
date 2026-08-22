"use client";

import { useEffect, useRef, useState } from "react";
import { usePathname } from "next/navigation";
import { RaniCollecting, type CollectNode } from "@/components/RaniCollecting";
import { RaniRadar } from "@/components/RaniRadar";

/**
 * App-wide "collection in progress" surface. Polls the active workspace's scan
 * status and shows the Rani-running animation whenever a scrape is underway
 * (a deep read, a monitored refresh, or a re-collect) — on Home or any page —
 * then auto-hides. Onboarding has its own inline version, so we skip it there.
 */
type Job = { name?: string; status: string; lat?: number | null; lng?: number | null; isTarget?: boolean };

// Catchy, rotating "what Rani's up to" lines — personality over raw stats.
const PHRASES = [
  "Rani's peeking at the competition 👀",
  "Reading the neighbours' sale flyers 🧾",
  "Spotting who just dropped their prices 💸",
  "Scanning fresh posts & photos 📸",
  "Sizing up this week's deals 🛒",
  "Seeing what your rivals are promoting 📣",
  "Catching the local buzz 🔍",
  "Peeking at the shelves next door 🫣",
];

export function CollectionBanner({ workspaceId }: { workspaceId: string }) {
  const pathname = usePathname();
  const [jobs, setJobs] = useState<Job[] | null>(null);
  const [ephemeral, setEphemeral] = useState(false);
  const [visible, setVisible] = useState(false);
  const [phrase, setPhrase] = useState(0);
  const wasActive = useRef(false);

  // rotate the catchy line while the banner is up
  useEffect(() => {
    if (!visible) return;
    const t = setInterval(() => setPhrase((p) => (p + 1) % PHRASES.length), 3200);
    return () => clearInterval(t);
  }, [visible]);

  useEffect(() => {
    if (!workspaceId || pathname?.startsWith("/onboarding")) return;
    let stopped = false, polls = 0, hideT: ReturnType<typeof setTimeout> | undefined;
    let timer: ReturnType<typeof setInterval> | undefined;
    const stop = () => { stopped = true; if (timer) clearInterval(timer); };

    const poll = async () => {
      polls++;
      try {
        const r = await fetch(`/api/collect/status?workspaceId=${workspaceId}`, { cache: "no-store" });
        if (!r.ok) return;
        const d = await r.json();
        const js = (d.jobs ?? []) as Job[];
        setEphemeral(!!d.ephemeral);
        // stay live through BOTH stages: per-business collection AND the flyer/image read
        const active = js.some((j) => j.status === "pending" || j.status === "running") || !!d.flyers;
        if (active) { wasActive.current = true; setJobs(js); setVisible(true); }
        else if (wasActive.current) {
          // just finished → show the "done" flourish briefly, then hide
          setJobs(js); setVisible(true); stop();
          hideT = setTimeout(() => { if (!stopped || true) setVisible(false); }, 6000);
        } else if (polls >= 7) {
          stop(); // ~40s with nothing collecting → this is an idle page, save cycles
        }
      } catch { /* transient */ }
    };
    poll();
    timer = setInterval(() => { if (!stopped) poll(); }, 6000);
    return () => { stop(); if (hideT) clearTimeout(hideT); };
  }, [workspaceId, pathname]);

  if (!visible || !jobs?.length) return null;
  const businesses: CollectNode[] = jobs.map((j) => ({
    name: j.name ?? "A business",
    status: (["pending", "running", "done", "error"].includes(j.status) ? j.status : "pending") as CollectNode["status"],
    lat: j.lat ?? null, lng: j.lng ?? null, isTarget: j.isTarget,
  }));
  const done = businesses.filter((b) => b.status === "done" || b.status === "error").length;
  const total = businesses.length;

  return (
    <section className="glass-strong mb-4 rounded-3xl p-4 sm:p-5">
      <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-brand-deep">
        <span aria-hidden>🛰️</span> {ephemeral ? "Deep read · scanning your market" : "Gathering your market intel"}
      </div>
      {ephemeral ? (
        <RaniRadar businesses={businesses} done={done} total={total} allDone={done >= total} />
      ) : (
        <RaniCollecting businesses={businesses} done={done} total={total} allDone={done >= total} />
      )}
      {/* catchy, rotating status — no raw stats, just "something's happening" + a soft ETA */}
      <div className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 border-t border-line/50 pt-2 text-sm">
        <span className="rani-dots" aria-hidden><span /><span /><span /></span>
        <span key={phrase} className="animate-fade-in font-medium text-brand-deep">{PHRASES[phrase]}</span>
        <span className="text-xs text-ink-faint">· usually a minute or two</span>
      </div>
    </section>
  );
}
