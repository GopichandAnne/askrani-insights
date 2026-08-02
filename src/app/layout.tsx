import type { Metadata } from "next";
import "./globals.css";
import Link from "next/link";
import { getUser, isSuperAdmin } from "@/lib/auth";
import { AppNav, MarketingBar, type NavItem } from "@/components/AppNav";
import { RaniWordmark } from "@/components/RaniSpinner";
import { listWorkspaces, activeWorkspace } from "@/lib/workspace";

export const metadata: Metadata = {
  title: "Ask Rani Insights — local market intelligence",
  description:
    "Understand what local businesses are doing, why it matters, and what to do next. By Ask Rani.",
};

const NAV: NavItem[] = [
  { href: "/", label: "Today", icon: "today" },
  { href: "/edge", label: "Your Edge", icon: "edge" },
  { href: "/explore", label: "Explore", icon: "explore" },
  { href: "/feed", label: "Market feed", icon: "feed" },
  { href: "/offers", label: "Offers", icon: "offers" },
  { href: "/competitors", label: "Competitors", icon: "competitors" },
  { href: "/channels", label: "Channels", icon: "channels" },
  { href: "/recommendations", label: "Recommendations", icon: "recommendations" },
  { href: "/reports", label: "Report", icon: "report" },
  { href: "/billing", label: "Billing", icon: "billing" },
  { href: "/onboarding", label: "New workspace", icon: "add" },
];

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const user = await getUser();
  const admin = isSuperAdmin(user);
  const nav = admin ? [...NAV, { href: "/admin", label: "Admin", icon: "admin" as const }] : NAV;

  // businesses this login can switch between (only meaningful when signed in)
  const workspaces = user ? await listWorkspaces() : [];
  const active = user ? await activeWorkspace() : null;
  const activeId = active?.status === "ok" ? active.workspace.id : "";

  return (
    <html lang="en">
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="" />
        <link
          href="https://fonts.googleapis.com/css2?family=Playfair+Display:ital,wght@0,700;0,800;1,700;1,800&family=DM+Sans:wght@400;500;600;700&display=swap"
          rel="stylesheet"
        />
      </head>
      <body>
        <div className="aurora-bg" aria-hidden />

        {user ? (
          // ── Signed-in app shell: glass sidebar + content ──────────────
          <div className="min-h-screen">
            <AppNav
              items={nav}
              email={user.email ?? undefined}
              admin={admin}
              workspaces={workspaces.map((w) => ({ id: w.id, name: w.name, vertical: w.vertical }))}
              activeWorkspaceId={activeId}
            />
            <main className="mx-auto w-full max-w-6xl px-4 pb-24 pt-4 sm:px-6 lg:pb-12 lg:pl-28 lg:pr-8 lg:pt-24">
              {children}
            </main>
          </div>
        ) : (
          // ── Signed-out marketing shell ────────────────────────────────
          <div className="flex min-h-screen flex-col">
            <MarketingBar />
            <main className="flex-1">{children}</main>
            <footer className="no-print border-t border-line/60">
              <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-3 px-6 py-6 text-sm text-ink-faint">
                <Link href="/" className="flex items-center gap-2">
                  <RaniWordmark compact />
                </Link>
                <span>
                  Local market intelligence · a product by{" "}
                  <span className="font-semibold text-brand-deep">Ask Rani</span> · insights.askrani.ai
                </span>
              </div>
            </footer>
          </div>
        )}
      </body>
    </html>
  );
}
