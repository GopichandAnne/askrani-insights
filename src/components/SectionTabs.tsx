"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { navHit, type NavSection } from "@/components/nav-config";

/**
 * Section sub-nav — the segmented control at the top of a surface (Watch / Grow)
 * that switches between its member pages, per the Simplicity v2 direction ("a
 * compact segmented control at the top of the surface"). Renders nothing on
 * single-page surfaces (Today / Ask). Pure representation — links to existing routes.
 */
export function SectionTabs({ sections }: { sections: NavSection[] }) {
  const pathname = usePathname() || "/";
  const active = sections.find((s) => navHit(pathname, [s.href, ...s.match]));
  if (!active?.members || active.members.length < 2) return null;

  return (
    <div className="no-print mb-5 -mx-1 flex gap-1.5 overflow-x-auto px-1 pb-1 [-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
      {active.members.map((m) => {
        const on = navHit(pathname, [m.href, ...(m.match ?? [])]);
        return (
          <Link
            key={m.href}
            href={m.href}
            data-active={on}
            className="shrink-0 rounded-full border border-line/60 bg-white/50 px-3.5 py-1.5 text-sm font-medium text-ink-soft transition-colors hover:border-brand/40 hover:text-brand data-[active=true]:border-transparent data-[active=true]:bg-brand-gradient data-[active=true]:text-white data-[active=true]:shadow-brand"
          >
            {m.label}
          </Link>
        );
      })}
    </div>
  );
}
