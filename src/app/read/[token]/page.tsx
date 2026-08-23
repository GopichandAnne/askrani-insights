import { notFound } from "next/navigation";
import Link from "next/link";
import { createServiceClient } from "@/lib/supabase/server";
import { ScorecardView } from "@/components/ScorecardView";
import type { Scorecard } from "@/lib/scorecard";

export const dynamic = "force-dynamic";

interface PublicRead { scorecard: Scorecard; businessName: string; at: string }

async function load(token: string): Promise<PublicRead | null> {
  const svc = createServiceClient();
  const { data } = await svc.from("workspace").select("goals").filter("goals->publicRead->>token", "eq", token).maybeSingle();
  return ((data?.goals as any)?.publicRead as PublicRead | undefined) ?? null;
}

export async function generateMetadata({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const pr = await load(token);
  return { title: pr ? `${pr.businessName} vs the market — Ask Rani` : "Market read — Ask Rani" };
}

export default async function ReadPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const pr = await load(token);
  if (!pr) notFound();

  return (
    <div className="mx-auto w-full max-w-5xl animate-fade-in space-y-6 px-4 py-8 sm:px-6">
      <div className="glass-strong relative overflow-hidden rounded-3xl p-6 text-center">
        <div className="pointer-events-none absolute inset-0 bg-brand-mesh opacity-[0.08]" aria-hidden />
        <div className="relative">
          <p className="text-xs font-semibold uppercase tracking-wide text-brand-deep">👀 Rani made you a free market read</p>
          <h1 className="mt-1 font-display text-2xl font-extrabold sm:text-3xl">{pr.businessName} — how you stack up</h1>
          <p className="mx-auto mt-2 max-w-xl text-sm text-ink-soft">Here&apos;s where you sit against your local competitors — rating, price, social reach, AI &amp; Google findability — and exactly where the wins are.</p>
        </div>
      </div>

      <ScorecardView sc={pr.scorecard} businessName={pr.businessName} publicView />

      <div className="glass-strong rounded-3xl p-6 text-center">
        <h2 className="font-display text-xl font-extrabold">Want Rani watching your market — every week?</h2>
        <p className="mx-auto mt-1.5 max-w-lg text-sm text-ink-soft">She&apos;ll keep an eye on your competitors&apos; prices, deals, posts and reviews — and tell you what to do next.</p>
        <Link href="/onboarding" className="btn btn-primary mt-4 px-6 py-2.5">Claim your free dashboard →</Link>
      </div>
      <p className="text-center text-xs text-ink-faint">Made with Ask Rani Insights · snapshot from {new Date(pr.at).toLocaleDateString()}</p>
    </div>
  );
}
