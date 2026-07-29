import { OnboardingClient } from "./OnboardingClient";

export const metadata = { title: "New workspace — local-intel" };

export default function OnboardingPage() {
  return (
    <div className="space-y-6">
      <section>
        <h1 className="text-2xl font-semibold tracking-tight">Analyze your local market</h1>
        <p className="mt-1 max-w-2xl text-ink-soft">
          Point us at your website and a few competitors. We crawl each one,
          extract structured offers, benchmark you against the set, and propose
          prioritized actions — every fact carries its source and confidence.
        </p>
      </section>
      <OnboardingClient />
    </div>
  );
}
