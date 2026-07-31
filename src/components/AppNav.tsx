"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { RaniWordmark, RaniMark } from "@/components/RaniSpinner";

export interface NavItem {
  href: string;
  label: string;
  icon: keyof typeof ICONS;
}

const I = { width: 20, height: 20, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 1.9, strokeLinecap: "round" as const, strokeLinejoin: "round" as const };
const ICONS = {
  today: (
    <svg {...I}><path d="M3 10.5 12 3l9 7.5" /><path d="M5 9.5V20a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V9.5" /><path d="M9.5 21v-6h5v6" /></svg>
  ),
  feed: (
    <svg {...I}><path d="M3 12h4l2 6 4-14 2.5 8H21" /></svg>
  ),
  offers: (
    <svg {...I}><path d="M20.6 13.4 13.4 20.6a2 2 0 0 1-2.8 0l-7-7A2 2 0 0 1 3 12.2V4a1 1 0 0 1 1-1h8.2a2 2 0 0 1 1.4.6l7 7a2 2 0 0 1 0 2.8Z" /><circle cx="7.5" cy="7.5" r="1.3" /></svg>
  ),
  competitors: (
    <svg {...I}><circle cx="9" cy="8" r="3.2" /><path d="M3.5 20a5.5 5.5 0 0 1 11 0" /><path d="M16 5.2A3.2 3.2 0 0 1 16 11" /><path d="M17.5 14.5A5.5 5.5 0 0 1 20.5 20" /></svg>
  ),
  recommendations: (
    <svg {...I}><path d="M9 18h6" /><path d="M10 21h4" /><path d="M12 3a6 6 0 0 0-3.5 10.9c.6.5 1 1.2 1 2h5c0-.8.4-1.5 1-2A6 6 0 0 0 12 3Z" /></svg>
  ),
  report: (
    <svg {...I}><path d="M6 3h9l5 5v13a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1Z" /><path d="M14 3v6h6" /><path d="M9 17v-3M12 17v-5M15 17v-2" /></svg>
  ),
  add: (
    <svg {...I}><circle cx="12" cy="12" r="9" /><path d="M12 8.5v7M8.5 12h7" /></svg>
  ),
  admin: (
    <svg {...I}><path d="M12 3 5 6v5c0 4.4 3 8 7 9 4-1 7-4.6 7-9V6l-7-3Z" /><path d="m9.5 12 1.8 1.8L15 10" /></svg>
  ),
};

export function AppNav({ items, email, homeHref = "/" }: { items: NavItem[]; email?: string; homeHref?: string }) {
  const pathname = usePathname() || "/";
  const isActive = (href: string) => (href === "/" ? pathname === "/" : pathname.startsWith(href));

  return (
    <>
      {/* ── Desktop sidebar ─────────────────────────────────────────── */}
      <aside className="no-print fixed inset-y-0 left-0 z-40 hidden w-64 flex-col p-3 lg:flex">
        <div className="glass flex h-full flex-col rounded-3xl p-4">
          <Link href={homeHref} aria-label="Ask Rani Insights home" className="px-2 py-1.5">
            <RaniWordmark />
          </Link>
          <nav className="mt-5 flex-1 space-y-1">
            {items.map((n) => (
              <Link key={n.href} href={n.href} className="nav-item" data-active={isActive(n.href)}>
                <span className="shrink-0">{ICONS[n.icon]}</span>
                <span>{n.label}</span>
              </Link>
            ))}
          </nav>
          {email && (
            <form action="/auth/signout" method="post" className="mt-3 border-t border-line/70 pt-3">
              <div className="truncate px-2 text-xs text-ink-faint" title={email}>{email}</div>
              <button type="submit" className="nav-item mt-1 w-full text-left">
                <svg {...I}><path d="M15 3h3a1 1 0 0 1 1 1v16a1 1 0 0 1-1 1h-3" /><path d="M10 17l-5-5 5-5" /><path d="M5 12h11" /></svg>
                <span>Sign out</span>
              </button>
            </form>
          )}
        </div>
      </aside>

      {/* ── Mobile top bar ──────────────────────────────────────────── */}
      <header className="no-print sticky top-0 z-40 lg:hidden">
        <div className="glass-strong flex items-center justify-between px-4 py-2.5">
          <Link href={homeHref} aria-label="Ask Rani Insights home"><RaniWordmark compact /></Link>
          {email && (
            <form action="/auth/signout" method="post">
              <button type="submit" className="rounded-full px-3 py-1 text-sm font-medium text-ink-soft hover:text-brand">Sign out</button>
            </form>
          )}
        </div>
      </header>

      {/* ── Mobile bottom tab bar ───────────────────────────────────── */}
      <nav className="no-print fixed inset-x-0 bottom-0 z-40 lg:hidden">
        <div className="glass-strong mx-auto flex max-w-xl items-center justify-around gap-1 px-2 py-1.5">
          {items.slice(0, 5).map((n) => (
            <Link
              key={n.href}
              href={n.href}
              aria-label={n.label}
              data-active={isActive(n.href)}
              className="flex flex-col items-center gap-0.5 rounded-xl px-3 py-1.5 text-[10px] font-medium text-ink-faint data-[active=true]:text-brand-deep"
            >
              <span className={isActive(n.href) ? "text-brand" : ""}>{ICONS[n.icon]}</span>
              <span>{n.label.split(" ")[0]}</span>
            </Link>
          ))}
        </div>
      </nav>
    </>
  );
}

/** Minimal marketing top bar for signed-out visitors (landing / login). */
export function MarketingBar({ signedOut = true }: { signedOut?: boolean }) {
  return (
    <header className="no-print sticky top-0 z-40">
      <div className="glass-strong mx-auto flex max-w-6xl items-center justify-between px-6 py-3">
        <Link href="/" aria-label="Ask Rani Insights home"><RaniWordmark /></Link>
        <div className="flex items-center gap-2">
          <Link href="/onboarding" className="hidden rounded-full px-4 py-2 text-sm font-medium text-ink-soft hover:text-brand sm:inline">
            Try it free
          </Link>
          {signedOut && (
            <Link href="/login" className="btn btn-primary px-5 py-2">
              Sign in <RaniMark size={16} />
            </Link>
          )}
        </div>
      </div>
    </header>
  );
}
