"use client";

import Script from "next/script";
import { usePathname, useSearchParams } from "next/navigation";
import { Suspense, useEffect } from "react";

/**
 * Google Analytics 4 — inert until NEXT_PUBLIC_GA_ID (a public "G-XXXX" tag id,
 * not a secret) is set in the environment. Loads gtag after the page is
 * interactive, and fires a page_view on every client-side route change (Next's
 * App Router doesn't reload the page, so GA's auto page_view would miss SPA
 * navigations). Nothing renders and no cookies are set when the id is absent.
 */

const GA_ID = process.env.NEXT_PUBLIC_GA_ID;

declare global {
  interface Window {
    gtag?: (...args: unknown[]) => void;
    dataLayer?: unknown[];
  }
}

/** Fire a custom GA event (no-op when GA isn't configured). Use for funnel
 *  milestones — e.g. track("explore_search", { area }). */
export function track(event: string, params: Record<string, unknown> = {}) {
  if (typeof window === "undefined" || typeof window.gtag !== "function") return;
  window.gtag("event", event, params);
}

function PageViews() {
  const pathname = usePathname();
  const search = useSearchParams();
  useEffect(() => {
    if (!GA_ID || typeof window.gtag !== "function") return;
    const url = pathname + (search?.toString() ? `?${search}` : "");
    window.gtag("event", "page_view", { page_path: url, page_location: window.location.href });
  }, [pathname, search]);
  return null;
}

export function Analytics() {
  if (!GA_ID) return null;
  return (
    <>
      <Script src={`https://www.googletagmanager.com/gtag/js?id=${GA_ID}`} strategy="afterInteractive" />
      <Script id="ga-init" strategy="afterInteractive">
        {`window.dataLayer = window.dataLayer || [];
function gtag(){dataLayer.push(arguments);}
window.gtag = gtag;
gtag('js', new Date());
gtag('config', '${GA_ID}', { send_page_view: false });`}
      </Script>
      <Suspense fallback={null}>
        <PageViews />
      </Suspense>
    </>
  );
}
