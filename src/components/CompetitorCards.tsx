import type { CompetitorCardsResult, CompetitorCard } from "@/lib/competitors";

/**
 * Per-competitor cards — one rival, one card: rating, price vs you, latest move,
 * best-performing post, and where to go look. Answers "what is this competitor
 * doing?" in a single glance instead of three separate screens.
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
  new_dish: "New item",
  new_product: "New product",
  new_treatment: "New treatment",
  price_change: "Price change",
  price_drop: "Price drop",
  promotion: "New promo",
  content: "Posted",
};
const changeLabel = (t: string) => CHANGE_LABEL[t] ?? t.replace(/_/g, " ");

const num = (n?: number) => (n == null ? null : n >= 1000 ? `${(n / 1000).toFixed(1).replace(/\.0$/, "")}k` : String(n));

function PricePosition({ price, you }: { price: CompetitorCard["price"]; you: number | null }) {
  if (price.avg == null) {
    return <span className="text-ink-faint">No prices captured</span>;
  }
  const tone =
    price.vsYou === "higher" ? "text-trust-direct" : price.vsYou === "lower" ? "text-coral-dark" : "text-ink-soft";
  const word =
    price.vsYou === "higher" ? `${price.deltaPct}% pricier than you` :
    price.vsYou === "lower" ? `${Math.abs(price.deltaPct ?? 0)}% cheaper than you` :
    price.vsYou === "similar" ? "about the same as you" :
    `${price.items} priced item${price.items === 1 ? "" : "s"}`;
  return (
    <>
      <span className="font-semibold text-brand-deep">~${price.avg.toFixed(2)}</span>{" "}
      <span className="text-ink-faint">avg</span>
      {you != null && <span className={`ml-1 font-medium ${tone}`}>· {word}</span>}
    </>
  );
}

function Card({ c, you }: { c: CompetitorCard; you: CompetitorCardsResult["you"] }) {
  return (
    <div className="card card-hover flex flex-col gap-3">
      {/* header: name + rating */}
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <span className="font-semibold">{c.name}</span>
            {c.subtype[0] && <span className="chip bg-surface-sunken text-ink-faint">{c.subtype[0].replace(/_/g, " ")}</span>}
          </div>
          <div className="mt-0.5 text-xs text-ink-faint">
            {c.relation}{c.distanceKm != null ? ` · ${c.distanceKm}km away` : ""}
          </div>
        </div>
        {c.rating && (
          <span className="shrink-0 rounded-xl bg-brand-soft px-2.5 py-1 text-right">
            <span className="font-bold text-brand-deep">{c.rating.score.toFixed(1)}★</span>
            {c.rating.reviewCount != null && (
              <span className="ml-1 text-[11px] text-ink-faint">{num(c.rating.reviewCount)} · {c.rating.source}</span>
            )}
          </span>
        )}
      </div>

      {/* price position vs you */}
      <div className="rounded-2xl bg-white/55 px-3 py-2 text-sm">
        <span className="mr-1.5" aria-hidden>💸</span>
        <PricePosition price={c.price} you={you.avgPrice} />
      </div>

      {/* latest move */}
      {c.recentChange ? (
        <div className="flex items-start gap-2 text-sm">
          <span className="chip shrink-0 bg-brand-soft text-brand">{changeLabel(c.recentChange.type)}</span>
          <span className="min-w-0 text-ink-soft">
            {c.recentChange.summary}
            {c.recentChange.at && <span className="text-ink-faint"> · {timeAgo(c.recentChange.at)}</span>}
          </span>
        </div>
      ) : (
        <div className="text-sm text-ink-faint">No changes detected recently.</div>
      )}

      {/* best-performing post */}
      {c.topPost && (
        <div className="rounded-2xl bg-white/55 p-3 text-sm">
          <div className="mb-1 flex items-center gap-2 text-xs font-medium text-ink-faint">
            <span aria-hidden>🔥</span> Best recent post · {c.topPost.platform}
          </div>
          <p className="line-clamp-2 text-ink-soft">{c.topPost.caption || "(no caption)"}</p>
          <div className="mt-1.5 flex items-center gap-3 text-xs text-ink-faint">
            {num(c.topPost.views) && <span>👁 {num(c.topPost.views)}</span>}
            {num(c.topPost.likes) && <span>❤ {num(c.topPost.likes)}</span>}
            {num(c.topPost.comments) && <span>💬 {num(c.topPost.comments)}</span>}
            {c.topPost.url && (
              <a href={c.topPost.url} target="_blank" rel="noreferrer" className="ml-auto font-medium text-brand hover:underline">
                View ↗
              </a>
            )}
          </div>
        </div>
      )}

      {/* go look */}
      {c.link && (
        <a
          href={c.link.url}
          target="_blank"
          rel="noreferrer"
          className="mt-auto inline-flex w-fit items-center gap-1.5 rounded-full bg-surface-sunken px-3 py-1.5 text-xs font-medium text-brand-deep transition-colors hover:bg-brand-soft"
        >
          {c.link.kind === "booking" ? "📅 Book / view" : "🔗 Visit site"} ↗
        </a>
      )}
    </div>
  );
}

export function CompetitorCards({ data }: { data: CompetitorCardsResult }) {
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
        One card per rival — their rating, prices vs yours, latest move and best post. Ranked by who moved most recently.
        {data.you.avgPrice != null && <> Your average priced item: <span className="font-medium text-brand-deep">${data.you.avgPrice.toFixed(2)}</span>.</>}
      </p>
      <div className="stagger grid gap-4 md:grid-cols-2">
        {data.cards.map((c) => (
          <Card key={c.businessId} c={c} you={data.you} />
        ))}
      </div>
    </div>
  );
}
