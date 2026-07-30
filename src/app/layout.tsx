import type { Metadata } from "next";
import "./globals.css";
import Link from "next/link";
import { getUser, isSuperAdmin } from "@/lib/auth";
import { RaniWordmark } from "@/components/RaniSpinner";

export const metadata: Metadata = {
  title: "Ask Rani Insights — local market intelligence",
  description:
    "Understand what local businesses are doing, why it matters, and what to do next. By Ask Rani.",
};

const NAV = [
  { href: "/", label: "Today" },
  { href: "/feed", label: "Market feed" },
  { href: "/offers", label: "Offers" },
  { href: "/competitors", label: "Competitors" },
  { href: "/recommendations", label: "Recommendations" },
  { href: "/reports", label: "Report" },
  { href: "/onboarding", label: "New workspace" },
];

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const user = await getUser();
  const admin = isSuperAdmin(user);
  const nav = admin ? [...NAV, { href: "/admin", label: "Admin" }] : NAV;
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
        <div className="flex min-h-screen flex-col">
          <header className="sticky top-0 z-50 border-b border-line bg-white/90 backdrop-blur">
            <div className="mx-auto flex max-w-6xl items-center gap-6 px-6 py-3">
              <Link href="/" aria-label="Ask Rani Insights home">
                <RaniWordmark />
              </Link>
              <nav className="hidden flex-wrap gap-5 text-sm font-medium text-ink-faint md:flex">
                {nav.map((n) => (
                  <Link key={n.href} href={n.href} className="transition-colors hover:text-brand">
                    {n.label}
                  </Link>
                ))}
              </nav>
              <div className="ml-auto text-sm">
                {user ? (
                  <form action="/auth/signout" method="post" className="flex items-center gap-3">
                    <span className="hidden text-ink-faint sm:inline">{user.email}</span>
                    <button type="submit" className="text-ink-soft transition-colors hover:text-brand">
                      Sign out
                    </button>
                  </form>
                ) : (
                  <Link href="/login" className="font-semibold text-brand hover:text-brand-deep">
                    Sign in
                  </Link>
                )}
              </div>
            </div>
          </header>

          <main className="mx-auto w-full max-w-6xl flex-1 px-6 py-8">{children}</main>

          <footer className="border-t border-line bg-white">
            <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-3 px-6 py-6 text-sm text-ink-faint">
              <span className="flex items-center gap-2">
                <RaniWordmark compact />
                <span className="text-ink-faint">Insights</span>
              </span>
              <span>
                Local market intelligence · a product by{" "}
                <span className="font-semibold text-brand-deep">Ask Rani</span> · insights.askrani.ai
              </span>
            </div>
          </footer>
        </div>
      </body>
    </html>
  );
}
