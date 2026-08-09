import Link from "next/link";
import { activeWorkspace } from "@/lib/workspace";
import { ScreenNotReady } from "@/components/ScreenNotReady";
import { MarketTabs } from "@/components/MarketTabs";
import { MarketTrends } from "@/components/MarketTrends";
import { MarketMemory } from "@/components/MarketMemory";
import { getMarketTrends, getMarketEvents } from "@/lib/panel";

export const dynamic = "force-dynamic";

/** Market hub — one home for the three market views (Feed · Offers · Competitors). */
export default async function MarketPage() {
  const state = await activeWorkspace();
  if (state.status !== "ok") return <ScreenNotReady state={state} title="Market" />;

  const [trends, memory] = await Promise.all([
    getMarketTrends(state.workspace),
    getMarketEvents(state.workspace),
  ]);

  const cards = [
    { href: "/feed", icon: "🛰️", title: "Market feed", desc: "Everything that changed — competitor price moves, new items, promos — plus a summarized local-news digest." },
    { href: "/offers", icon: "💸", title: "Offers & prices", desc: "Menu/item prices side by side: your price positioning vs rivals, and who's cheapest item-by-item." },
    { href: "/competitors", icon: "🧭", title: "Competitors", desc: "Your rivals on a map and ranked by match — add, remove, and see how close a competitor each one is." },
  ];

  return (
    <div className="animate-fade-in space-y-6">
      <header>
        <p className="text-sm font-medium text-brand-deep">Ask Rani Insights</p>
        <h1 className="mt-0.5 font-display text-3xl font-extrabold tracking-tight sm:text-4xl">Market</h1>
        <p className="mt-1 max-w-2xl text-ink-soft">Everything happening across {state.workspace.name} and its competitors, in one place.</p>
      </header>

      <MarketTabs />

      <MarketTrends trends={trends} />

      <MarketMemory memory={memory} />

      <div className="stagger grid gap-4 sm:grid-cols-3">
        {cards.map((c) => (
          <Link key={c.href} href={c.href} className="card card-hover glow-hover flex flex-col">
            <span className="grid h-11 w-11 place-items-center rounded-2xl bg-brand-soft text-2xl">{c.icon}</span>
            <h2 className="mt-3 font-semibold">{c.title}</h2>
            <p className="mt-1 flex-1 text-sm text-ink-faint">{c.desc}</p>
            <span className="mt-3 text-sm font-medium text-brand">Open →</span>
          </Link>
        ))}
      </div>
    </div>
  );
}
