import { MonitorQueueClient } from "@/components/MonitorQueueClient";

export const dynamic = "force-dynamic";
export const metadata = { title: "Monitoring queue — Ask Rani Insights" };

/**
 * Validate the businesses we'll watch — confirm each Instagram handle is the right
 * account, then start collecting only what you approve. The human gate before any
 * collection credit is spent (the cold-collect GTM step for Austin desi businesses).
 */
export default function MonitorQueuePage() {
  return (
    <div className="animate-fade-in space-y-6">
      <header>
        <p className="text-sm font-medium text-brand-deep">Confirm before we watch</p>
        <h1 className="mt-0.5 font-display text-3xl font-extrabold tracking-tight sm:text-4xl">Monitoring queue</h1>
        <p className="mt-1 max-w-2xl text-ink-soft">
          Instagram handles we found from each business&apos;s own website. Open a profile to check it&apos;s
          the right account, fix any that are wrong, then start collecting only the ones you approve.
          Nothing is collected until you press the button.
        </p>
      </header>
      <MonitorQueueClient />
    </div>
  );
}
