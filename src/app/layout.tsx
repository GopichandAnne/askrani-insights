import type { Metadata } from "next";
import "./globals.css";
import Link from "next/link";
import { getUser } from "@/lib/auth";

export const metadata: Metadata = {
  title: "local-intel — Local Business Intelligence",
  description:
    "Understand what local businesses are doing, why it matters, and what to do next.",
};

const NAV = [
  { href: "/", label: "Today" },
  { href: "/feed", label: "Market feed" },
  { href: "/offers", label: "Offers" },
  { href: "/competitors", label: "Competitors" },
  { href: "/recommendations", label: "Recommendations" },
  { href: "/onboarding", label: "New workspace" },
  { href: "/admin", label: "Admin" },
];

export default async function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const user = await getUser();
  return (
    <html lang="en">
      <body>
        <div className="min-h-screen">
          <header className="border-b border-line bg-surface">
            <div className="mx-auto flex max-w-6xl items-center gap-6 px-6 py-3">
              <Link href="/" className="font-semibold tracking-tight">
                local<span className="text-brand">·</span>intel
              </Link>
              <nav className="flex flex-wrap gap-4 text-sm text-ink-soft">
                {NAV.map((n) => (
                  <Link
                    key={n.href}
                    href={n.href}
                    className="hover:text-ink"
                  >
                    {n.label}
                  </Link>
                ))}
              </nav>
              <div className="ml-auto text-sm">
                {user ? (
                  <form action="/auth/signout" method="post" className="flex items-center gap-3">
                    <span className="hidden text-ink-faint sm:inline">{user.email}</span>
                    <button type="submit" className="text-ink-soft hover:text-ink">
                      Sign out
                    </button>
                  </form>
                ) : (
                  <Link href="/login" className="text-brand hover:underline">
                    Sign in
                  </Link>
                )}
              </div>
            </div>
          </header>
          <main className="mx-auto max-w-6xl px-6 py-8">{children}</main>
        </div>
      </body>
    </html>
  );
}
