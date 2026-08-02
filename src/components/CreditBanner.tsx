"use client";

import { useEffect, useState } from "react";
import Link from "next/link";

/** Slim banner shown when the org is low on / out of monitoring credits.
 *  Explore + viewing stay free; this only nudges toward topping up for monitoring. */
const LOW = 20;

export function CreditBanner() {
  const [balance, setBalance] = useState<number | null>(null);

  useEffect(() => {
    let alive = true;
    fetch("/api/credits").then((r) => (r.ok ? r.json() : null)).then((d) => { if (alive && d && typeof d.balance === "number") setBalance(d.balance); }).catch(() => {});
    return () => { alive = false; };
  }, []);

  if (balance === null || balance > LOW) return null;
  const empty = balance <= 0;

  return (
    <div className={`no-print mb-4 flex flex-wrap items-center justify-between gap-2 rounded-2xl px-4 py-2.5 text-sm ${empty ? "bg-coral/12 text-coral-dark" : "bg-trust-inferred/10 text-trust-inferred"}`}>
      <span>
        {empty ? "⚠️ Monitoring is paused — you're out of credits." : `⏳ Low on credits — ${balance} left.`}{" "}
        <span className="opacity-80">Exploring stays free.</span>
      </span>
      <Link href="/billing" className="shrink-0 font-semibold underline">Add credits →</Link>
    </div>
  );
}
