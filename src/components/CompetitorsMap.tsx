"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import dynamic from "next/dynamic";
import type { MapPoint } from "@/components/MapPicker";

const MapPicker = dynamic(() => import("@/components/MapPicker").then((m) => m.MapPicker), {
  ssr: false,
  loading: () => <div className="grid h-[380px] place-items-center rounded-2xl border border-line/60 bg-surface-sunken text-sm text-ink-faint">Loading map…</div>,
});

/** Post-onboarding competitor map: see your store + rivals on a map, tap a rival
 *  pin to remove it. Points come from the server (business geo in attributes). */
export function CompetitorsMap({ points }: { points: MapPoint[] }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);

  async function onPick(id: string) {
    if (!id.startsWith("comp:")) return;
    if (busy) return;
    setBusy(true);
    try {
      await fetch("/api/competitors/remove", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ edgeId: id.slice(5) }),
      });
      router.refresh();
    } finally { setBusy(false); }
  }

  if (!points.length) return null;

  return (
    <div className="card p-2">
      <MapPicker points={points} onPick={onPick} height={400} />
      <div className="mt-2 flex flex-wrap items-center gap-3 px-1 pb-1 text-[11px] text-ink-faint">
        <span className="flex items-center gap-1"><Dot c="#0d9488" /> You</span>
        <span className="flex items-center gap-1"><Dot c="#0f766e" /> Competitor — tap a pin to remove</span>
      </div>
    </div>
  );
}

function Dot({ c }: { c: string }) {
  return <span className="inline-block h-2.5 w-2.5 rounded-full" style={{ background: c }} aria-hidden />;
}
