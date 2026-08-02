"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

/** Sub-navigation across the Market group (Feed · Offers · Competitors), so the
 *  three related views feel like one section under a single nav item. */
const TABS: [string, string][] = [
  ["/market", "Overview"],
  ["/feed", "Feed"],
  ["/offers", "Offers & prices"],
  ["/competitors", "Competitors"],
];

export function MarketTabs() {
  const path = usePathname() || "";
  return (
    <div className="no-print flex flex-wrap gap-1.5">
      {TABS.map(([href, label]) => {
        const active = path === href;
        return (
          <Link
            key={href}
            href={href}
            className={`rounded-full px-3.5 py-1.5 text-sm font-medium transition-all ${active ? "bg-brand-gradient text-white shadow-brand" : "glass text-ink-soft hover:text-ink hover:shadow-glow"}`}
          >
            {label}
          </Link>
        );
      })}
    </div>
  );
}
