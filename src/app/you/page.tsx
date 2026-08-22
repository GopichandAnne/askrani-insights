import { redirect } from "next/navigation";
import { activeWorkspace } from "@/lib/workspace";
import { isAreaMode } from "@/lib/subject";
import { collectionActive } from "@/lib/jobs";
import { CollectingScreen } from "@/components/CollectingScreen";
import { createClient } from "@/lib/supabase/server";
import { ScreenNotReady } from "@/components/ScreenNotReady";
import { getOrMakeYou, platformLabel, type YouReport, type ReviewToAnswer } from "@/lib/you";
import type { ReviewPulse } from "@/lib/pulse";
import { ActOnIt } from "@/components/ActOnIt";
import { PulseColumns } from "@/components/PulseColumns";
import { RatingRankChart } from "@/components/RatingRankChart";

export const dynamic = "force-dynamic";
export const maxDuration = 45; // room for the reviews LLM read on a cold cache

const HEALTH: Record<string, { chip: string; label: string; ring: string }> = {
  strong: { chip: "bg-trust-direct/15 text-trust-direct", label: "Strong", ring: "text-trust-direct" },
  watch: { chip: "bg-brand-soft text-brand", label: "Worth watching", ring: "text-brand" },
  at_risk: { chip: "bg-coral/15 text-coral-dark", label: "Needs attention", ring: "text-coral-dark" },
};

function num(n?: number | null): string {
  if (n == null) return "—";
  return n >= 1000 ? `${(n / 1000).toFixed(1).replace(/\.0$/, "")}k` : String(n);
}

function Stars({ rating }: { rating: number | null }) {
  if (rating == null) return null;
  const full = Math.floor(rating);
  const half = rating - full >= 0.4;
  return (
    <span aria-hidden className="text-brand">
      {"★".repeat(full)}{half ? "⯨" : ""}<span className="text-line">{"★".repeat(Math.max(0, 5 - full - (half ? 1 : 0)))}</span>
    </span>
  );
}

function Reputation({ r }: { r: YouReport["reputation"] }) {
  const deltaGood = (r.delta ?? 0) >= 0;
  return (
    <section className="card">
      <div className="flex flex-wrap items-start gap-x-8 gap-y-4">
        <div>
          <p className="text-xs font-semibold uppercase tracking-wide text-ink-faint">Your rating</p>
          <div className="mt-1 flex items-end gap-2">
            <span className="font-display text-4xl font-extrabold text-brand-deep">{r.rating != null ? r.rating.toFixed(1) : "—"}</span>
            <span className="pb-1 text-lg"><Stars rating={r.rating} /></span>
          </div>
          <p className="mt-0.5 text-xs text-ink-faint">{r.reviewCount != null ? `${num(r.reviewCount)} reviews` : "reviews not captured"}</p>
        </div>

        {r.marketAvg != null && (
          <div>
            <p className="text-xs font-semibold uppercase tracking-wide text-ink-faint">Vs. your market</p>
            <div className="mt-1 flex items-baseline gap-2">
              <span className={`font-display text-2xl font-bold ${deltaGood ? "text-trust-direct" : "text-coral-dark"}`}>
                {r.delta != null ? `${deltaGood ? "+" : ""}${r.delta.toFixed(1)}` : "—"}
              </span>
              <span className="text-sm text-ink-faint">vs {r.marketAvg.toFixed(1)}★ avg</span>
            </div>
            {r.rank != null && <p className="mt-0.5 text-xs text-ink-faint">Ranked <span className="font-semibold text-brand-deep">#{r.rank}</span> of {r.total} nearby</p>}
          </div>
        )}

        {r.sources.length > 0 && (
          <div className="min-w-0">
            <p className="text-xs font-semibold uppercase tracking-wide text-ink-faint">By source</p>
            <div className="mt-1.5 flex flex-wrap gap-1.5">
              {r.sources.map((s, i) => (
                <span key={i} className="chip bg-surface-sunken text-ink-soft">
                  {platformLabel(s.source)} {s.rating}★{s.reviewCount != null ? ` · ${num(s.reviewCount)}` : ""}
                </span>
              ))}
            </div>
          </div>
        )}
      </div>

      <RatingRankChart peers={r.peers} marketAvg={r.marketAvg} />

      {r.velocity ? (
        <div className="mt-4 flex flex-wrap items-center gap-x-2 gap-y-1 border-t border-line/60 pt-3 text-sm">
          <span className="chip bg-trust-direct/12 text-trust-direct">📈 Review velocity</span>
          <span className="text-ink-soft">
            <span className="font-semibold text-brand-deep">+{r.velocity.reviewsAdded}</span> reviews in {r.velocity.windowDays} day{r.velocity.windowDays === 1 ? "" : "s"}
            {r.velocity.perWeek > 0 && <> · ~<span className="font-medium">{r.velocity.perWeek}/wk</span></>}
            {r.velocity.ratingDelta != null && r.velocity.ratingDelta !== 0 && (
              <> · rating <span className={`font-medium ${r.velocity.ratingDelta > 0 ? "text-trust-direct" : "text-coral-dark"}`}>{r.velocity.ratingDelta > 0 ? "▲" : "▼"} {Math.abs(r.velocity.ratingDelta).toFixed(1)}</span></>
            )}
          </span>
        </div>
      ) : r.tracking ? (
        <p className="mt-4 border-t border-line/60 pt-3 text-xs text-ink-faint">⏳ Tracking your review trend — it appears here once we&apos;ve captured a few days of history.</p>
      ) : null}
    </section>
  );
}

function AnswerCard({ r, businessName }: { r: ReviewToAnswer; businessName: string }) {
  return (
    <div className="rounded-2xl bg-white/55 p-3.5">
      <div className="flex items-start justify-between gap-2">
        <p className="min-w-0 flex-1 border-l-2 border-line pl-2.5 text-sm italic text-ink-soft">“{r.quote}”</p>
        <span className="chip shrink-0 bg-surface-sunken text-ink-faint">{r.why}</span>
      </div>
      <div className="mt-2 rounded-xl bg-brand-soft/60 p-2.5 text-sm text-brand-deep">
        <span className="font-semibold">Suggested reply:</span> {r.reply}
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-3">
        <ActOnIt kind="reply" move={`Reply to this ${businessName} review: "${r.quote}"`} context={r.why} reviewName={r.reviewName} small />
        {r.url && (
          <a href={r.url} target="_blank" rel="noreferrer" className="inline-flex min-h-[36px] items-center text-xs font-medium text-brand hover:underline">
            Open the review to respond ↗
          </a>
        )}
      </div>
    </div>
  );
}

export default async function YouPage() {
  const state = await activeWorkspace();
  if (state.status !== "ok") return <ScreenNotReady state={state} title="You" />;
  if (isAreaMode(state.workspace)) redirect("/market"); // area workspaces have no "you"
  if (await collectionActive(state.workspace.id)) return <CollectingScreen workspaceId={state.workspace.id} title="You" />;

  const you = await getOrMakeYou(state.workspace);
  const h = HEALTH[you.synthesis.health] ?? HEALTH.watch;
  const price = you.price;

  // review pulse — read the CACHED value only (built by the warm step) so the page
  // stays fast; shows what's CHANGING in reviews week-over-week.
  const supabase = await createClient();
  const { data: pRow } = await supabase.from("workspace").select("goals").eq("id", state.workspace.id).maybeSingle();
  const pulse = (pRow?.goals as any)?.pulse as ReviewPulse | undefined;

  return (
    <div className="animate-fade-in space-y-6">
      <div>
        <p className="text-sm font-medium text-brand-deep">Ask Rani Insights</p>
        <h1 className="mt-1 font-display text-3xl font-extrabold tracking-tight">You</h1>
        <p className="mt-1 max-w-2xl text-sm text-ink-soft">
          How <span className="font-medium text-brand-deep">{you.name}</span> is doing — your reputation, what customers love and want fixed,
          where you&apos;re listed, and how your prices sit. All from your own reviews and listings.
        </p>
      </div>

      {/* health headline */}
      <section className="card-hero">
        <div className="flex flex-wrap items-center gap-3">
          <span className={`chip ${h.chip}`}>{h.label}</span>
          <h2 className="font-display text-xl font-extrabold">{you.synthesis.headline}</h2>
        </div>
        {you.synthesis.summary && <p className="mt-2 max-w-3xl text-sm text-white/90">{you.synthesis.summary}</p>}
      </section>

      <Reputation r={you.reputation} />

      {pulse && !pulse.failed && (pulse.emerging.length > 0 || pulse.rising.length > 0 || pulse.fading.length > 0 || pulse.summary) && (
        <section className="card">
          <h2 className="mb-1 flex items-center gap-2 font-semibold">
            <span className="grid h-7 w-7 place-items-center rounded-lg bg-brand-soft text-brand">📈</span>
            What&apos;s changing in your reviews
          </h2>
          {(pulse.newReviews != null || pulse.ratingDelta != null) && (
            <p className="text-xs text-ink-faint">
              {pulse.newReviews != null ? `${pulse.newReviews} new review${pulse.newReviews === 1 ? "" : "s"}` : ""}
              {pulse.ratingDelta != null ? `${pulse.newReviews != null ? " · " : ""}rating ${pulse.ratingDelta >= 0 ? "+" : ""}${pulse.ratingDelta}★` : ""}
              {pulse.windowDays ? ` over ~${pulse.windowDays} days` : ""}
            </p>
          )}
          {pulse.summary && <p className="mt-2 text-sm text-ink-soft">{pulse.summary}</p>}
          <PulseColumns columns={[
            { title: "⚠ Emerging", tone: "text-coral-dark", items: pulse.emerging.map((e) => e.theme), empty: "Nothing new to worry about" },
            { title: "↑ Rising praise", tone: "text-brand-deep", items: pulse.rising, empty: "—" },
            { title: "↓ Fading", tone: "text-ink-faint", items: pulse.fading, empty: "—" },
          ]} />
        </section>
      )}

      {/* loves + gripes */}
      {(you.synthesis.loves.length > 0 || you.synthesis.gripes.length > 0) && (
        <div className="grid gap-6 lg:grid-cols-2">
          <section className="card">
            <h2 className="mb-3 flex items-center gap-2 font-semibold">
              <span className="grid h-7 w-7 place-items-center rounded-lg bg-trust-direct/15 text-trust-direct">♥</span>
              What customers love
            </h2>
            {you.synthesis.loves.length ? (
              <ul className="stagger space-y-1.5">
                {you.synthesis.loves.map((l, i) => (
                  <li key={i} className="flex items-start gap-2 rounded-2xl bg-white/55 p-2.5 text-sm text-ink-soft">
                    <span className="text-trust-direct" aria-hidden>✓</span>{l}
                  </li>
                ))}
              </ul>
            ) : <p className="text-sm text-ink-faint">Nothing clear yet.</p>}
          </section>

          <section className="card">
            <h2 className="mb-3 flex items-center gap-2 font-semibold">
              <span className="grid h-7 w-7 place-items-center rounded-lg bg-coral/15 text-coral-dark">⚠</span>
              What to fix
            </h2>
            {you.synthesis.gripes.length ? (
              <ul className="stagger space-y-2">
                {you.synthesis.gripes.map((g, i) => (
                  <li key={i} className="rounded-2xl bg-white/55 p-3 text-sm">
                    <p className="font-medium text-ink">{g.theme}</p>
                    <p className="mt-0.5 text-ink-soft"><span className="font-semibold text-brand-deep">Fix:</span> {g.fix}</p>
                  </li>
                ))}
              </ul>
            ) : <p className="text-sm text-ink-faint">No recurring complaints — nice.</p>}
          </section>
        </div>
      )}

      {/* reviews to answer */}
      {you.synthesis.reviewsToAnswer.length > 0 && (
        <section className="card">
          <h2 className="mb-3 flex items-center gap-2 font-semibold">
            <span className="grid h-7 w-7 place-items-center rounded-lg bg-brand-soft text-brand">↩</span>
            Reviews worth answering
          </h2>
          <div className="space-y-3">
            {you.synthesis.reviewsToAnswer.slice(0, 2).map((r, i) => <AnswerCard key={i} r={r} businessName={you.name} />)}
          </div>
          {you.synthesis.reviewsToAnswer.length > 2 && (
            <details className="mt-3">
              <summary className="inline-flex cursor-pointer list-none items-center gap-1 rounded-xl px-3 py-2 text-xs font-semibold text-brand-deep hover:bg-brand-soft/60">
                Show {you.synthesis.reviewsToAnswer.length - 2} more <span aria-hidden>›</span>
              </summary>
              <div className="mt-2 space-y-3">
                {you.synthesis.reviewsToAnswer.slice(2).map((r, i) => <AnswerCard key={i + 2} r={r} businessName={you.name} />)}
              </div>
            </details>
          )}
        </section>
      )}

      {/* discoverability + price */}
      <div className="grid gap-6 lg:grid-cols-2">
        <section className="card">
          <div className="flex items-center justify-between">
            <h2 className="flex items-center gap-2 font-semibold">
              <span className="grid h-7 w-7 place-items-center rounded-lg bg-brand-soft text-brand">📇</span>
              Your listings
            </h2>
            <span className="text-sm font-bold text-brand-deep">{you.discoverability.scorePct}%</span>
          </div>
          <p className="mt-0.5 text-xs text-ink-faint">Which platforms list your business — where customers can find you.</p>
          <div className="mt-3 flex flex-wrap gap-1.5">
            {you.discoverability.present.map((p, i) => (
              <span key={i} className="chip bg-trust-direct/12 text-trust-direct">✓ {platformLabel(p.platform)}</span>
            ))}
            {you.discoverability.missing.map((p, i) => (
              <span key={i} className="chip border border-dashed border-line text-ink-faint">＋ {platformLabel(p)}</span>
            ))}
          </div>
          {you.discoverability.missing.length > 0 && (
            <p className="mt-2.5 text-xs text-ink-soft">
              Not yet on <span className="font-medium text-ink">{you.discoverability.missing.map(platformLabel).join(", ")}</span> — each is a listing customers check when they look for you.
            </p>
          )}
          <a href="/findability" className="mt-3 inline-block text-xs font-medium text-brand hover:underline">Where you rank in Google search →</a>
        </section>

        <section className="card">
          <h2 className="mb-3 flex items-center gap-2 font-semibold">
            <span className="grid h-7 w-7 place-items-center rounded-lg bg-brand-soft text-brand">💸</span>
            Your prices vs the market
          </h2>
          {price.avg != null ? (
            <>
              <div className="flex items-end gap-2">
                <span className="font-display text-3xl font-extrabold text-brand-deep">${price.avg.toFixed(2)}</span>
                <span className="pb-1 text-sm text-ink-faint">avg item</span>
              </div>
              {price.marketAvg != null ? (
                <p className="mt-1 text-sm text-ink-soft">
                  {price.position === "higher" ? <><span className="font-semibold text-trust-direct">{price.deltaPct}% above</span> the market</> :
                   price.position === "lower" ? <><span className="font-semibold text-coral-dark">{Math.abs(price.deltaPct ?? 0)}% below</span> the market</> :
                   <>about the <span className="font-semibold">same as</span> the market</>}
                  {" "}(rivals avg ${price.marketAvg.toFixed(2)}).
                </p>
              ) : <p className="mt-1 text-sm text-ink-faint">No rival prices captured yet to compare.</p>}
            </>
          ) : <p className="text-sm text-ink-faint">No priced items captured yet.</p>}
        </section>
      </div>

      <p className="text-center text-xs text-ink-faint">
        Read from {you.reviewsAnalyzed} of your reviews{you.usedGoogleSummary ? " + a full-review summary (Summarized with Gemini)" : ""} · updates after each scan.
      </p>
    </div>
  );
}
