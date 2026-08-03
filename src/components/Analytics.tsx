"use client";

import Script from "next/script";
import { usePathname, useSearchParams } from "next/navigation";
import { Suspense, useEffect, useState } from "react";

/**
 * Google Analytics 4 — inert until NEXT_PUBLIC_GA_ID (a public "G-XXXX" tag id,
 * not a secret) is set AND the visitor has accepted analytics cookies via the
 * consent banner. Loads gtag only after consent, and fires a page_view on every
 * client-side route change (Next's App Router doesn't reload the page, so GA's
 * auto page_view would miss SPA navigations).
 */

export const GA_ID = process.env.NEXT_PUBLIC_GA_ID;
export const CONSENT_KEY = "ar_consent"; // localStorage: "granted" | "denied"
export const CONSENT_EVENT = "ar-consent-changed";

declare global {
  interface Window {
    gtag?: (...args: unknown[]) => void;
    dataLayer?: unknown[];
  }
}

/** Current consent state, kept in sync across the app via a window event. */
export function useConsent(): "granted" | "denied" | "unset" {
  const [consent, setConsent] = useState<"granted" | "denied" | "unset">("unset");
  useEffect(() => {
    const read = () => {
      const v = localStorage.getItem(CONSENT_KEY);
      setConsent(v === "granted" ? "granted" : v === "denied" ? "denied" : "unset");
    };
    read();
    window.addEventListener(CONSENT_EVENT, read);
    return () => window.removeEventListener(CONSENT_EVENT, read);
  }, []);
  return consent;
}

export function setConsent(value: "granted" | "denied") {
  try { localStorage.setItem(CONSENT_KEY, value); } catch { /* ignore */ }
  window.dispatchEvent(new Event(CONSENT_EVENT));
}

/** Fire a custom GA event (no-op when GA isn't loaded / consent not granted).
 *  Use for funnel milestones — e.g. track("explore_search", { area }). */
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
  const consent = useConsent();
  if (!GA_ID || consent !== "granted") return null;
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
