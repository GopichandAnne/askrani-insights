import Link from "next/link";
import type { ScreenState } from "@/lib/workspace";

/** Consistent messaging for the non-ok workspace states across data screens. */
export function ScreenNotReady({
  state,
  title,
}: {
  state: Exclude<ScreenState, { status: "ok" }>;
  title: string;
}) {
  const body =
    state.status === "unconfigured"
      ? "Supabase isn't configured yet. Add the Supabase keys to .env.local to enable saving and these screens."
      : state.status === "signedout"
        ? "Sign in to see your saved workspace intelligence."
        : "No saved workspace yet. Run a market analysis and it will be saved here.";
  const cta =
    state.status === "signedout"
      ? { href: "/login", label: "Sign in →" }
      : { href: "/onboarding", label: "Run a market analysis →" };

  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
      <div className="rounded-xl border border-dashed border-line bg-surface p-6 text-sm text-ink-soft">
        <p>{body}</p>
        <Link href={cta.href} className="mt-3 inline-flex text-brand hover:underline">
          {cta.label}
        </Link>
      </div>
    </div>
  );
}
