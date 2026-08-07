"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import { RaniWordmark, RaniMark } from "@/components/RaniSpinner";
import { CommandPalette } from "@/components/CommandPalette";
import { WorkspaceSwitcher, type WsOption } from "@/components/WorkspaceSwitcher";

export interface NavItem {
  href: string;
  label: string;
  icon: keyof typeof ICONS;
  match?: string[]; // extra path prefixes that should highlight this item (grouping)
}

const I = { width: 20, height: 20, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 1.9, strokeLinecap: "round" as const, strokeLinejoin: "round" as const };
const ICONS = {
  today: <svg {...I}><path d="M3 10.5 12 3l9 7.5" /><path d="M5 9.5V20a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V9.5" /><path d="M9.5 21v-6h5v6" /></svg>,
  you: <svg {...I}><circle cx="12" cy="8" r="3.6" /><path d="M5 20a7 7 0 0 1 14 0" /></svg>,
  edge: <svg {...I}><path d="M13 2 4.5 13H11l-1 9 8.5-11H12l1-9z" /></svg>,
  explore: <svg {...I}><circle cx="11" cy="11" r="7" /><path d="m21 21-4.3-4.3" /></svg>,
  market: <svg {...I}><path d="M3 9l1.5-5h15L21 9" /><path d="M4 9v10a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1V9" /><path d="M3 9h18" /><path d="M9 13h6" /></svg>,
  around: <svg {...I}><circle cx="12" cy="12" r="9" /><path d="M3.5 9h17M3.5 15h17" /><path d="M12 3a14 14 0 0 0 0 18a14 14 0 0 0 0-18Z" /></svg>,
  billing: <svg {...I}><rect x="2.5" y="5" width="19" height="14" rx="2.5" /><path d="M2.5 10h19" /></svg>,
  feed: <svg {...I}><path d="M3 12h4l2 6 4-14 2.5 8H21" /></svg>,
  offers: <svg {...I}><path d="M20.6 13.4 13.4 20.6a2 2 0 0 1-2.8 0l-7-7A2 2 0 0 1 3 12.2V4a1 1 0 0 1 1-1h8.2a2 2 0 0 1 1.4.6l7 7a2 2 0 0 1 0 2.8Z" /><circle cx="7.5" cy="7.5" r="1.3" /></svg>,
  competitors: <svg {...I}><circle cx="9" cy="8" r="3.2" /><path d="M3.5 20a5.5 5.5 0 0 1 11 0" /><path d="M16 5.2A3.2 3.2 0 0 1 16 11" /><path d="M17.5 14.5A5.5 5.5 0 0 1 20.5 20" /></svg>,
  channels: <svg {...I}><rect x="3" y="3" width="18" height="18" rx="4" /><circle cx="12" cy="12" r="3.4" /><circle cx="17" cy="7" r="1.2" fill="currentColor" stroke="none" /></svg>,
  recommendations: <svg {...I}><path d="M9 18h6" /><path d="M10 21h4" /><path d="M12 3a6 6 0 0 0-3.5 10.9c.6.5 1 1.2 1 2h5c0-.8.4-1.5 1-2A6 6 0 0 0 12 3Z" /></svg>,
  report: <svg {...I}><path d="M6 3h9l5 5v13a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1Z" /><path d="M14 3v6h6" /><path d="M9 17v-3M12 17v-5M15 17v-2" /></svg>,
  add: <svg {...I}><circle cx="12" cy="12" r="9" /><path d="M12 8.5v7M8.5 12h7" /></svg>,
  admin: <svg {...I}><path d="M12 3 5 6v5c0 4.4 3 8 7 9 4-1 7-4.6 7-9V6l-7-3Z" /><path d="m9.5 12 1.8 1.8L15 10" /></svg>,
};
const SHORT: Record<string, string> = {
  "/": "Week", "/you": "You", "/edge": "Edge", "/explore": "Explore", "/around": "Around", "/market": "Market", "/feed": "Changes", "/offers": "Offers", "/competitors": "Rivals", "/channels": "Channels",
  "/recommendations": "Actions", "/reports": "Report", "/billing": "Billing", "/onboarding": "New", "/admin": "Admin",
};

function useCommandKey(setOpen: (f: (o: boolean) => boolean) => void) {
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") { e.preventDefault(); setOpen((o) => !o); }
    };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [setOpen]);
}

function fmtCredits(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(n >= 10000 ? 0 : 1).replace(/\.0$/, "")}k` : String(n);
}
function CreditsPill({ credits }: { credits: number | null }) {
  if (credits == null) return null;
  const low = credits <= 20;
  return (
    <Link
      href="/billing"
      title={`${credits.toLocaleString()} monitoring credits · manage billing`}
      className={`flex shrink-0 items-center gap-1.5 rounded-full px-3 py-2 text-sm font-semibold transition-all hover:shadow-glow ${low ? "bg-coral/15 text-coral-dark" : "glass text-brand-deep"}`}
    >
      <span aria-hidden>⚡</span>
      <span className="tabular-nums">{fmtCredits(credits)}</span>
      <span className="hidden text-xs font-normal text-ink-faint sm:inline">credits</span>
    </Link>
  );
}

export function AppNav({ items, email, admin, workspaces = [], activeWorkspaceId = "", credits = null }: { items: NavItem[]; email?: string; admin?: boolean; workspaces?: WsOption[]; activeWorkspaceId?: string; credits?: number | null }) {
  const pathname = usePathname() || "/";
  const [open, setOpen] = useState(false);
  useCommandKey(setOpen);
  const isActive = (n: NavItem) => {
    const hrefs = [n.href, ...(n.match ?? [])];
    return hrefs.some((h) => (h === "/" ? pathname === "/" : pathname === h || pathname.startsWith(h + "/")));
  };

  const AskTrigger = ({ className = "" }: { className?: string }) => (
    <button
      onClick={() => setOpen(true)}
      className={`glass group flex items-center gap-2.5 rounded-full px-4 py-2.5 text-left text-sm text-ink-faint transition-all hover:text-ink hover:shadow-glow ${className}`}
    >
      <span className="text-brand" aria-hidden>✦</span>
      <span className="truncate">Ask Rani or jump to anything…</span>
      <kbd className="ml-auto hidden shrink-0 items-center gap-0.5 rounded-md bg-white/70 px-1.5 py-0.5 text-[10px] font-semibold text-ink-faint sm:flex">⌘K</kbd>
    </button>
  );

  return (
    <>
      {/* ── Desktop icon rail ───────────────────────────────────────── */}
      <aside className="no-print fixed inset-y-0 left-0 z-40 hidden w-20 p-2 lg:flex">
        <div className="glass flex h-full w-full flex-col items-center rounded-3xl py-3">
          <Link href="/" aria-label="Ask Rani Insights home" className="mb-2"><RaniMark size={32} /></Link>
          <nav className="flex w-full flex-1 flex-col items-center gap-1 px-1.5">
            {items.map((n) => (
              <Link
                key={n.href}
                href={n.href}
                data-active={isActive(n)}
                title={n.label}
                className="flex w-full flex-col items-center gap-1 rounded-2xl px-1 py-2 text-[10px] font-medium text-ink-faint transition-all hover:bg-brand-soft hover:text-brand-deep data-[active=true]:bg-brand-gradient data-[active=true]:text-white data-[active=true]:shadow-brand"
              >
                {ICONS[n.icon]}
                <span>{SHORT[n.href] ?? n.label}</span>
              </Link>
            ))}
          </nav>
          {email && (
            <form action="/auth/signout" method="post" className="mt-1 w-full px-1.5">
              <button type="submit" title={`Sign out (${email})`} className="flex w-full flex-col items-center gap-1 rounded-2xl px-1 py-2 text-[10px] font-medium text-ink-faint transition-colors hover:bg-trust-low/10 hover:text-trust-low">
                <svg {...I}><path d="M15 3h3a1 1 0 0 1 1 1v16a1 1 0 0 1-1 1h-3" /><path d="M10 17l-5-5 5-5" /><path d="M5 12h11" /></svg>
                <span>Sign out</span>
              </button>
            </form>
          )}
        </div>
      </aside>

      {/* ── Desktop top command bar ─────────────────────────────────── */}
      <header className="no-print fixed right-0 top-0 z-30 hidden lg:left-20 lg:block">
        <div className="px-6 pt-3">
          <div className="glass-strong flex items-center gap-3 rounded-2xl px-3 py-2">
            {workspaces.length > 0 && <WorkspaceSwitcher workspaces={workspaces} activeId={activeWorkspaceId} />}
            <AskTrigger className="w-full max-w-md" />
            <div className="ml-auto flex items-center gap-3">
              <CreditsPill credits={credits} />
              {email && <span className="hidden truncate px-1 text-xs text-ink-faint lg:inline" title={email}>{email}</span>}
            </div>
          </div>
        </div>
      </header>

      {/* ── Mobile top bar ──────────────────────────────────────────── */}
      <header className="no-print sticky top-0 z-40 lg:hidden">
        <div className="glass-strong flex items-center gap-2 px-4 py-2.5">
          <Link href="/" aria-label="home" className="shrink-0"><RaniMark size={26} /></Link>
          {workspaces.length > 0 && <WorkspaceSwitcher workspaces={workspaces} activeId={activeWorkspaceId} />}
          <AskTrigger className="max-w-[40%] flex-1" />
          <span className="ml-auto"><CreditsPill credits={credits} /></span>
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
              data-active={isActive(n)}
              className="flex flex-col items-center gap-0.5 rounded-xl px-3 py-1.5 text-[10px] font-medium text-ink-faint data-[active=true]:text-brand-deep"
            >
              <span className={isActive(n) ? "text-brand" : ""}>{ICONS[n.icon]}</span>
              <span>{SHORT[n.href] ?? n.label.split(" ")[0]}</span>
            </Link>
          ))}
        </div>
      </nav>

      <CommandPalette open={open} onClose={() => setOpen(false)} admin={admin} />
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
          <a
            href="https://askrani.ai"
            className="hidden rounded-full px-4 py-2 text-sm font-medium text-ink-soft hover:text-brand sm:inline"
          >
            ← Ask Rani
          </a>
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
