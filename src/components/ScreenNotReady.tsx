import Link from "next/link";
import type { ScreenState } from "@/lib/workspace";
import { RaniMark } from "@/components/RaniSpinner";

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
    <div className="space-y-4 animate-fade-in">
      <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
      <div className="flex flex-col items-center gap-4 rounded-xl border border-dashed border-line bg-surface p-10 text-center">
        <RaniMark size={44} />
        <p className="max-w-sm text-sm text-ink-soft">{body}</p>
        <Link href={cta.href} className="btn btn-primary">
          {cta.label}
        </Link>
      </div>
    </div>
  );
}
