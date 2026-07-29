"use client";

import { useActionState } from "react";
import Link from "next/link";
import { analyzeMarket, type AnalysisResult, type AnalyzedBusiness } from "./actions";
import { TrustChip, ProvenanceBadge } from "@/components/TrustChip";

const initial: AnalysisResult = {
  ok: false,
  llmUsed: false,
  signedIn: false,
  saved: false,
  target: null,
  competitors: [],
  recommendations: [],
};

export function OnboardingClient() {
  const [state, formAction, pending] = useActionState(analyzeMarket, initial);

  return (
    <div className="space-y-8">
      <form action={formAction} className="rounded-xl border border-line bg-surface p-6">
        <div className="grid gap-4 sm:grid-cols-2">
          <label className="block">
            <span className="text-sm font-medium">Your business website</span>
            <input
              name="targetUrl"
              type="url"
              required
              placeholder="https://your-restaurant.com"
              className="mt-1 w-full rounded-lg border border-line px-3 py-2 text-sm"
            />
          </label>
          <label className="block">
            <span className="text-sm font-medium">Competitor websites</span>
            <textarea
              name="competitorUrls"
              rows={3}
              placeholder="One URL per line (up to 6)"
              className="mt-1 w-full rounded-lg border border-line px-3 py-2 text-sm"
            />
          </label>
        </div>
        <div className="mt-4 flex items-center gap-3">
          <button
            type="submit"
            disabled={pending}
            className="rounded-lg bg-brand px-4 py-2 text-sm font-medium text-white disabled:opacity-60"
          >
            {pending ? "Analyzing the market…" : "Run live analysis"}
          </button>
          <span className="text-xs text-ink-faint">
            Crawls each site, extracts offers, benchmarks and recommends — no signup.
          </span>
        </div>
      </form>

      {pending && (
        <p className="text-sm text-ink-soft">
          Crawling websites and extracting structured offers. This can take
          20–60s depending on site size…
        </p>
      )}

      {state.error && (
        <p className="rounded-lg border border-trust-low/30 bg-trust-low/5 p-4 text-sm text-trust-low">
          {state.error}
        </p>
      )}

      {state.ok && (
        <>
          {state.saved ? (
            <div className="flex flex-wrap items-center gap-3 rounded-lg border border-trust-direct/30 bg-trust-direct/5 p-3 text-sm text-trust-direct">
              <span>Saved to your workspace. It now feeds your ongoing screens.</span>
              <Link href="/recommendations" className="font-medium underline">
                View recommendations →
              </Link>
              <Link href="/offers" className="font-medium underline">
                View offers →
              </Link>
            </div>
          ) : state.savedError ? (
            <div className="rounded-lg border border-trust-low/30 bg-trust-low/5 p-3 text-sm text-trust-low">
              Analysis ran, but saving failed: {state.savedError}
            </div>
          ) : !state.signedIn ? (
            <div className="flex items-center gap-3 rounded-lg border border-line bg-surface p-3 text-sm text-ink-soft">
              <span>This is a live preview.</span>
              <Link href="/login" className="font-medium text-brand hover:underline">
                Sign in to save it to a workspace →
              </Link>
            </div>
          ) : null}

          {!state.llmUsed && (
            <p className="rounded-lg border border-trust-inferred/30 bg-trust-inferred/5 p-3 text-xs text-trust-inferred">
              Running in structured-markup-only mode (no <code>ANTHROPIC_API_KEY</code> set). Offers
              shown come from each site's JSON-LD/menu markup. Add a key to enable
              multimodal extraction of captions, flyers and images.
            </p>
          )}

          {state.recommendations.length > 0 && (
            <section>
              <h2 className="text-lg font-semibold">Recommended actions</h2>
              <p className="text-sm text-ink-soft">
                Prioritized by expected impact × confidence × urgency ÷ effort (guide §10).
              </p>
              <div className="mt-3 space-y-3">
                {state.recommendations.map((r, i) => (
                  <div key={i} className="rounded-xl border border-line bg-surface p-4">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="chip bg-brand-soft text-brand">{r.category}</span>
                      <span className="font-medium">{r.title}</span>
                      <span className="ml-auto text-xs text-ink-faint">
                        priority {r.priority} · {r.effort} effort · {r.urgency.replace("_", " ")}
                      </span>
                    </div>
                    <p className="mt-2 text-sm">{r.action}</p>
                    <ul className="mt-2 list-disc space-y-0.5 pl-5 text-sm text-ink-soft">
                      {r.why_now.map((w, j) => (
                        <li key={j}>{w}</li>
                      ))}
                    </ul>
                    <div className="mt-2 text-xs text-ink-faint">
                      Expected {r.expected_impact.metric}: +{r.expected_impact.range_pct[0]}–
                      {r.expected_impact.range_pct[1]}% ({Math.round(r.expected_impact.confidence * 100)}% conf).
                      Evidence: {r.evidence.slice(0, 3).join("; ")}
                    </div>
                  </div>
                ))}
              </div>
            </section>
          )}

          <section className="grid gap-4 lg:grid-cols-2">
            {state.target && <BusinessCard biz={state.target} highlight />}
            {state.competitors.map((c, i) => (
              <BusinessCard key={i} biz={c} />
            ))}
          </section>
        </>
      )}
    </div>
  );
}

function BusinessCard({ biz, highlight }: { biz: AnalyzedBusiness; highlight?: boolean }) {
  return (
    <div className={`rounded-xl border p-4 ${highlight ? "border-brand bg-brand-soft/30" : "border-line bg-surface"}`}>
      <div className="flex items-center justify-between">
        <div>
          <div className="font-medium">{biz.name}</div>
          <div className="text-xs text-ink-faint">{biz.url}</div>
        </div>
        <span className="text-xs text-ink-faint">
          {biz.offers.length} offers · {biz.pagesFetched} pages
        </span>
      </div>
      {biz.offers.length === 0 ? (
        <p className="mt-3 text-sm text-ink-faint">
          No structured offers extracted from this site.
        </p>
      ) : (
        <ul className="mt-3 space-y-1.5">
          {biz.offers.slice(0, 12).map((o, i) => (
            <li key={i} className="flex items-center justify-between gap-2 text-sm">
              <span className="truncate">{o.entity_text}</span>
              <span className="flex shrink-0 items-center gap-2">
                {o.amount != null && (
                  <span className="font-medium">
                    {o.currency === "USD" ? "$" : ""}
                    {o.amount}
                  </span>
                )}
                <TrustChip confidence={o.confidence} />
              </span>
            </li>
          ))}
        </ul>
      )}
      {biz.offers[0] && (
        <div className="mt-3">
          <ProvenanceBadge provenance={biz.offers[0].provenance} />
        </div>
      )}
    </div>
  );
}
