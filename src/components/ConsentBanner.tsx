"use client";

import { GA_ID, useConsent, setConsent } from "@/components/Analytics";

/**
 * Cookie-consent banner. Only appears when analytics is actually configured
 * (NEXT_PUBLIC_GA_ID set) and the visitor hasn't chosen yet — no GA cookies are
 * set until they accept, so declining keeps the site cookie-free. First-party,
 * server-side event logging is cookieless and unaffected by this choice.
 */
export function ConsentBanner() {
  const consent = useConsent();
  if (!GA_ID || consent !== "unset") return null;

  return (
    <div className="no-print fixed inset-x-0 bottom-0 z-50 p-3 sm:p-4">
      <div className="glass-strong mx-auto flex max-w-3xl flex-col items-start gap-3 rounded-2xl p-4 shadow-glass sm:flex-row sm:items-center">
        <p className="flex-1 text-sm text-ink-soft">
          We use privacy-friendly analytics cookies to understand how the site is used and make it
          better. Nothing is set unless you accept.
        </p>
        <div className="flex shrink-0 gap-2">
          <button
            onClick={() => setConsent("denied")}
            className="rounded-full px-4 py-2 text-sm font-medium text-ink-soft transition-colors hover:bg-surface-sunken"
          >
            Decline
          </button>
          <button
            onClick={() => setConsent("granted")}
            className="btn btn-primary px-5 py-2 text-sm"
          >
            Accept
          </button>
        </div>
      </div>
    </div>
  );
}
