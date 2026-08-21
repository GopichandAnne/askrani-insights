"use client";

import { useState } from "react";
import type { CompetitorCardsResult, CompetitorCard, CompetitorPost, CompetitorChange } from "@/lib/competitors";
import type { PriceGap } from "@/lib/pricegaps";

const normName = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");
function gapChip(g: PriceGap): { cls: string; txt: string } {
  if (g.verdict === "you_cheaper") return { cls: "bg-trust-direct/15 text-trust-direct", txt: `you ${g.yourPrice} ✓` };
  if (g.verdict === "undercut") return { cls: "bg-coral/15 text-coral-dark", txt: g.yourPrice ? `you ${g.yourPrice}` : "you pricier" };
  return { cls: "bg-surface-sunken text-ink-faint", txt: "you n/a" };
}

/**
 * Per-competitor cards — one rival, one card: rating, price vs you, latest move,
 * best post, and where to go look. Click "More details" to expand into the full
 * picture: every recent move, top posts, a menu/service sample with prices, and
 * per-source ratings. Answers "what is this competitor doing?" without hopping.
 */

function timeAgo(iso: string | null): string {
  if (!iso) return "";
  const diff = Date.now() - new Date(iso).getTime();
  const d = Math.round(diff / 86_400_000);
  if (d <= 0) return "today";
  if (d === 1) return "yesterday";
  if (d < 30) return `${d}d ago`;
  return new Date(iso).toLocaleDateString();
}

const CHANGE_LABEL: Record<string, string> = {
  new_dish: "New item", new_product: "New product", new_treatment: "New treatment",
  price_change: "Price change", price_drop: "Price drop", sale_started: "New promo",
  promotion: "New promo", menu_removed: "Removed", content: "Posted",
};
const changeLabel = (t: string) => CHANGE_LABEL[t] ?? t.replace(/_/g, " ");
const num = (n?: number | null) => (n == null ? null : n >= 1000 ? `${(n / 1000).toFixed(1).replace(/\.0$/, "")}k` : String(n));
const SRC = (s: string) => ({ google: "Google", yelp: "Yelp", facebook: "Facebook", tripadvisor: "Tripadvisor" }[s] ?? s);

function PricePosition({ price, you }: { price: CompetitorCard["price"]; you: number | null }) {
  if (price.avg == null) return <span className="text-ink-faint">No prices captured</span>;
  const tone = price.vsYou === "higher" ? "text-trust-direct" : price.vsYou === "lower" ? "text-coral-dark" : "text-ink-soft";
  const word =
    price.vsYou === "higher" ? `${price.deltaPct}% pricier than you` :
    price.vsYou === "lower" ? `${Math.abs(price.deltaPct ?? 0)}% cheaper than you` :
    price.vsYou === "similar" ? "about the same as you" :
    `${price.items} priced item${price.items === 1 ? "" : "s"}`;
  return (
    <>
      <span className="font-semibold text-brand-deep">~${price.avg.toFixed(2)}</span> <span className="text-ink-faint">avg</span>
      {you != null && <span className={`ml-1 font-medium ${tone}`}>· {word}</span>}
    </>
  );
}

function Post({ p }: { p: CompetitorPost }) {
  return (
    <div className="rounded-2xl bg-white/55 p-3 text-sm">
      <div className="mb-1 flex items-center gap-2 text-xs font-medium text-ink-faint"><span aria-hidden>🔥</span>{p.platform}</div>
      <p className="line-clamp-2 text-ink-soft">{p.caption || "(no caption)"}</p>
      <div className="mt-1.5 flex items-center gap-3 text-xs text-ink-faint">
        {num(p.views) && <span>👁 {num(p.views)}</span>}
        {num(p.likes) && <span>❤ {num(p.likes)}</span>}
        {num(p.comments) && <span>💬 {num(p.comments)}</span>}
        {p.url && <a href={p.url} target="_blank" rel="noreferrer" className="ml-auto font-medium text-brand hover:underline">View ↗</a>}
      </div>
    </div>
  );
}

function ChangeRow({ c }: { c: CompetitorChange }) {
  return (
    <li className="flex items-start gap-2 text-sm">
      <span className="chip shrink-0 bg-brand-soft text-brand">{changeLabel(c.type)}</span>
      <span className="min-w-0 text-ink-soft">{c.summary}{c.at && <span className="text-ink-faint"> · {timeAgo(c.at)}</span>}</span>
    </li>
  );
}

function Card({ c, you, gaps }: { c: CompetitorCard; you: CompetitorCardsResult["you"]; gaps?: PriceGap[] }) {
  const [open, setOpen] = useState(false);
  const [allGaps, setAllGaps] = useState(false);
  const latest = c.recentChanges[0];
  const topPost = c.topPosts[0];
  const hasGaps = !!gaps && gaps.length > 0;
  const moreCount = Math.max(0, c.recentChanges.length - 1) + Math.max(0, c.topPosts.length - 1) + c.offers.length + (gaps?.length ?? 0);

  return (
    <div className="card flex flex-col gap-3">
      {/* header */}
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <span className="font-semibold">{c.name}</span>
            {c.subtype[0] && <span className="chip bg-surface-sunken text-ink-faint">{c.subtype[0].replace(/_/g, " ")}</span>}
          </div>
          <div className="mt-0.5 text-xs text-ink-faint">{c.relation}{c.distanceKm != null ? ` · ${c.distanceKm}km away` : ""}</div>
        </div>
        {c.rating && (
          <span className="shrink-0 rounded-xl bg-brand-soft px-2.5 py-1 text-right">
            <span className="font-bold text-brand-deep">{c.rating.score.toFixed(1)}★</span>
            {c.rating.reviewCount != null && <span className="ml-1 text-[11px] text-ink-faint">{num(c.rating.reviewCount)} · {SRC(c.rating.source)}</span>}
          </span>
        )}
      </div>

      {/* price */}
      <div className="rounded-2xl bg-white/55 px-3 py-2 text-sm"><span className="mr-1.5" aria-hidden>💸</span><PricePosition price={c.price} you={you.avgPrice} /></div>

      {/* latest move */}
      {latest ? (
        <div className="flex items-start gap-2 text-sm">
          <span className="chip shrink-0 bg-brand-soft text-brand">{changeLabel(latest.type)}</span>
          <span className="min-w-0 text-ink-soft">{latest.summary}{latest.at && <span className="text-ink-faint"> · {timeAgo(latest.at)}</span>}</span>
        </div>
      ) : (
        <div className="text-sm text-ink-faint">No changes detected recently.</div>
      )}

      {/* best post */}
      {topPost && <Post p={topPost} />}

      {/* expand */}
      {moreCount > 0 && (
        <button onClick={() => setOpen((o) => !o)} className="w-fit text-xs font-medium text-brand hover:underline">
          {open ? "Show less ▴" : hasGaps ? "Prices vs you · more ▾" : "More details ▾"}
        </button>
      )}

      {open && (
        <div className="space-y-4 border-t border-line/70 pt-3">
          {/* prices vs you — biggest gaps first (the drill-down default) */}
          {hasGaps && (
            <div>
              <p className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-ink-faint">Prices vs you · biggest gaps first</p>
              <ul className="divide-y divide-line/50">
                {(allGaps ? gaps! : gaps!.slice(0, 6)).map((g, i) => {
                  const chip = gapChip(g);
                  return (
                    <li key={i} className="flex items-center justify-between gap-2 py-1.5 text-sm">
                      <span className="min-w-0 truncate text-ink">{g.item}</span>
                      <span className="flex shrink-0 items-center gap-2">
                        <span className="font-semibold tabular-nums text-ink">{g.rivalPrice}</span>
                        <span className={`chip ${chip.cls} tabular-nums`}>{chip.txt}</span>
                      </span>
                    </li>
                  );
                })}
              </ul>
              {gaps!.length > 6 && (
                <button onClick={() => setAllGaps((a) => !a)} className="mt-2 text-xs font-medium text-brand hover:underline">
                  {allGaps ? "Show fewer" : `Show all ${gaps!.length} priced items`}
                </button>
              )}
            </div>
          )}

          {/* all ratings */}
          {c.ratingSources.length > 1 && (
            <div>
              <p className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-ink-faint">Ratings by source</p>
              <div className="flex flex-wrap gap-1.5">
                {c.ratingSources.map((s, i) => (
                  <span key={i} className="chip bg-surface-sunken text-ink-soft">{SRC(s.source)} {s.rating}★{s.reviewCount != null ? ` · ${num(s.reviewCount)}` : ""}</span>
                ))}
              </div>
            </div>
          )}

          {/* more recent moves */}
          {c.recentChanges.length > 1 && (
            <div>
              <p className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-ink-faint">Recent moves</p>
              <ul className="space-y-1.5">{c.recentChanges.slice(1).map((ch, i) => <ChangeRow key={i} c={ch} />)}</ul>
            </div>
          )}

          {/* more posts */}
          {c.topPosts.length > 1 && (
            <div>
              <p className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-ink-faint">More top posts</p>
              <div className="grid gap-2 sm:grid-cols-2">{c.topPosts.slice(1).map((p, i) => <Post key={i} p={p} />)}</div>
            </div>
          )}

          {/* menu / services sample */}
          {c.offers.length > 0 && (
            <div>
              <p className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-ink-faint">
                What they sell{c.price.min != null && c.price.max != null ? <span className="ml-1 font-normal normal-case text-ink-faint">· ${c.price.min.toFixed(0)}–${c.price.max.toFixed(0)}</span> : null}
              </p>
              <ul className="divide-y divide-line/50">
                {c.offers.map((o, i) => (
                  <li key={i} className="flex items-center justify-between gap-2 py-1.5 text-sm">
                    <span className="min-w-0 truncate text-ink-soft">{o.item}</span>
                    {o.price != null && <span className="shrink-0 font-semibold text-brand-deep">${o.price.toFixed(2)}</span>}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}

      {/* go look */}
      {c.link && (
        <a href={c.link.url} target="_blank" rel="noreferrer" className="mt-auto inline-flex w-fit items-center gap-1.5 rounded-full bg-surface-sunken px-3 py-1.5 text-xs font-medium text-brand-deep transition-colors hover:bg-brand-soft">
          {c.link.kind === "booking" ? "📅 Book / view" : "🔗 Visit site"} ↗
        </a>
      )}
    </div>
  );
}

export function CompetitorCards({ data, gapsByRival }: { data: CompetitorCardsResult; gapsByRival?: Record<string, PriceGap[]> }) {
  if (!data.cards.length) {
    return (
      <p className="card border-dashed text-sm text-ink-soft">
        No competitors yet. Add some from a market analysis, or on the map below.
      </p>
    );
  }
  return (
    <div>
      <p className="mb-3 text-xs text-ink-faint">
        One card per rival — their rating, prices vs yours, latest move and best post. Click <span className="font-medium">More details</span> for the full picture.
        {data.you.avgPrice != null && <> Your average priced item: <span className="font-medium text-brand-deep">${data.you.avgPrice.toFixed(2)}</span>.</>}
      </p>
      <div className="grid items-start gap-4 md:grid-cols-2">
        {data.cards.map((c) => (<Card key={c.businessId} c={c} you={data.you} gaps={gapsByRival?.[normName(c.name)]} />))}
      </div>
    </div>
  );
}
