import { activeWorkspace } from "@/lib/workspace";
import { ScreenNotReady } from "@/components/ScreenNotReady";
import { DraftButton } from "@/components/DraftButton";
import { getOrMakeWinning, type WinningEntity } from "@/lib/winning";

export const dynamic = "force-dynamic";
export const maxDuration = 60; // room for the fusion LLM read on a cold cache

const MOMENTUM: Record<string, { chip: string; label: string }> = {
  hot: { chip: "bg-coral/15 text-coral-dark", label: "🔥 Hot" },
  rising: { chip: "bg-brand-soft text-brand", label: "📈 Rising" },
  steady: { chip: "bg-surface-sunken text-ink-soft", label: "• Steady" },
};

function Row({ w }: { w: WinningEntity }) {
  const m = MOMENTUM[w.momentum] ?? MOMENTUM.steady;
  return (
    <div className="rounded-2xl bg-white/55 p-3.5">
      <div className="flex flex-wrap items-center gap-2">
        <span className={`chip ${m.chip}`}>{m.label}</span>
        <span className="font-semibold">{w.name}</span>
        {w.onYourMenu
          ? <span className="chip bg-trust-direct/12 text-trust-direct">✓ on your menu</span>
          : <span className="chip bg-coral/10 text-coral-dark">not on your menu</span>}
        <span className="ml-auto text-xs text-ink-faint">
          {w.offeredBy > 0 && <>at {w.offeredBy} nearby</>}{w.priceRange ? ` · ${w.priceRange}` : ""}
        </span>
      </div>
      <p className="mt-1.5 text-sm text-ink-soft">{w.signal}</p>
      {w.move && (
        <div className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1">
          <p className="flex-1 text-sm text-brand-deep"><span aria-hidden>✦</span> <span className="font-semibold">Your move:</span> {w.move}</p>
          <DraftButton move={w.move} context={`Winning offering: ${w.name}`} />
        </div>
      )}
    </div>
  );
}

export default async function WinningPage() {
  const state = await activeWorkspace();
  if (state.status !== "ok") return <ScreenNotReady state={state} title="What's winning" />;

  const w = await getOrMakeWinning(state.workspace);
  const gaps = w.winning.filter((x) => !x.onYourMenu);
  const yours = w.winning.filter((x) => x.onYourMenu);
  const nothing = !w.summary && w.winning.length === 0;

  return (
    <div className="animate-fade-in space-y-6">
      <div>
        <p className="text-sm font-medium text-brand-deep">Ask Rani Insights</p>
        <h1 className="mt-1 font-display text-3xl font-extrabold tracking-tight">What&apos;s winning</h1>
        <p className="mt-1 max-w-2xl text-sm text-ink-soft">
          The specific dishes and offerings winning in your market right now — fused from who offers them, what
          reviews say, and what&apos;s getting social traction — and whether they&apos;re on your menu.
        </p>
      </div>

      {nothing ? (
        <div className="card border-dashed">
          <p className="text-sm text-ink-soft">
            <span className="font-semibold text-ink">Nothing yet.</span> Once we&apos;ve collected menus, reviews and
            posts across your market, we&apos;ll pull out the specific offerings that are winning — and which ones you&apos;re missing.
          </p>
        </div>
      ) : (
        <>
          {w.summary && (
            <section className="card bg-brand-hero text-white">
              <h2 className="flex items-center gap-2 font-display text-lg font-extrabold"><span aria-hidden>🏆</span> The read</h2>
              <p className="mt-1.5 max-w-3xl text-sm text-white/90">{w.summary}</p>
            </section>
          )}

          {/* the killer insight: winning items you DON'T offer */}
          {gaps.length > 0 && (
            <section className="card">
              <h2 className="mb-1 flex items-center gap-2 font-semibold">
                <span className="grid h-7 w-7 place-items-center rounded-lg bg-brand-gradient text-white shadow-brand">🎯</span>
                Gaps to grab — winning, but not on your menu
              </h2>
              <p className="mb-3 text-xs text-ink-faint">Offerings pulling customers to your rivals that you don&apos;t have yet.</p>
              <div className="space-y-2.5">{gaps.map((x, i) => <Row key={i} w={x} />)}</div>
            </section>
          )}

          {/* your winners — double down */}
          {yours.length > 0 && (
            <section className="card">
              <h2 className="mb-1 flex items-center gap-2 font-semibold">
                <span className="grid h-7 w-7 place-items-center rounded-lg bg-trust-direct/15 text-trust-direct">★</span>
                Your winning offerings — double down
              </h2>
              <p className="mb-3 text-xs text-ink-faint">Things you already offer that are winning market-wide — lean into them.</p>
              <div className="space-y-2.5">{yours.map((x, i) => <Row key={i} w={x} />)}</div>
            </section>
          )}

          <p className="text-center text-xs text-ink-faint">Fused from {w.entitiesSeen} offerings across your market · updates after each scan.</p>
        </>
      )}
    </div>
  );
}
