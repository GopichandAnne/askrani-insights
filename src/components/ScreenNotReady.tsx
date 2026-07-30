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
      ? "This site isn't fully set up yet. Please check back shortly."
      : state.status === "signedout"
        ? "Sign in to see your market insights."
        : "You haven't set up your business yet — let's do that. It takes about two minutes.";
  const cta =
    state.status === "signedout"
      ? { href: "/login", label: "Sign in" }
      : { href: "/onboarding", label: "Set up my business" };

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
