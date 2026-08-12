import Stripe from "stripe";
import { PLANS } from "@/lib/credits";

/**
 * Stripe integration (Phase 3). Dormant until STRIPE_SECRET_KEY is set. Prices
 * are created in the Stripe dashboard; their ids come from env so we never
 * hardcode them. The catalog maps a stable client-facing `key` to its price,
 * mode, and how many credits it grants — the client never passes a price id.
 */

export function isStripeConfigured(): boolean {
  return !!process.env.STRIPE_SECRET_KEY;
}
let _stripe: Stripe | null = null;
export function stripe(): Stripe {
  if (!_stripe) _stripe = new Stripe(process.env.STRIPE_SECRET_KEY ?? "");
  return _stripe;
}

export interface CatalogItem { price?: string; mode: "subscription" | "payment"; credits: number; plan?: string; label: string; priceUsd: number; }

export const CATALOG: Record<string, CatalogItem> = {
  starter: { price: process.env.STRIPE_PRICE_STARTER, mode: "subscription", plan: "starter", credits: PLANS.starter.monthlyCredits, label: "Starter", priceUsd: PLANS.starter.priceUsd },
  growth: { price: process.env.STRIPE_PRICE_GROWTH, mode: "subscription", plan: "growth", credits: PLANS.growth.monthlyCredits, label: "Growth", priceUsd: PLANS.growth.priceUsd },
  pro: { price: process.env.STRIPE_PRICE_PRO, mode: "subscription", plan: "pro", credits: PLANS.pro.monthlyCredits, label: "Pro", priceUsd: PLANS.pro.priceUsd },
  topup_500: { price: process.env.STRIPE_PRICE_TOPUP_500, mode: "payment", credits: 500, label: "500 credits", priceUsd: 29 },
  topup_1500: { price: process.env.STRIPE_PRICE_TOPUP_1500, mode: "payment", credits: 1500, label: "1,500 credits", priceUsd: 75 },
  topup_5000: { price: process.env.STRIPE_PRICE_TOPUP_5000, mode: "payment", credits: 5000, label: "5,000 credits", priceUsd: 199 },
};

/** Which catalog keys are actually buyable (have a configured price id). */
export function availableKeys(): string[] {
  return Object.entries(CATALOG).filter(([, v]) => !!v.price).map(([k]) => k);
}

export interface PaymentLink { key: string; label: string; url: string }
/** Optional shareable Stripe Payment Link URLs (created in the dashboard), read
 *  from env. Used by the admin console to hand out per-org links. Only the ones
 *  actually set are returned. */
export function paymentLinks(): PaymentLink[] {
  const defs: [string, string, string | undefined][] = [
    ["starter", "Starter", process.env.STRIPE_LINK_STARTER],
    ["growth", "Growth", process.env.STRIPE_LINK_GROWTH],
    ["pro", "Pro", process.env.STRIPE_LINK_PRO],
    ["topup_500", "500 credits", process.env.STRIPE_LINK_TOPUP_500],
    ["topup_1500", "1,500 credits", process.env.STRIPE_LINK_TOPUP_1500],
    ["topup_5000", "5,000 credits", process.env.STRIPE_LINK_TOPUP_5000],
  ];
  return defs.filter(([, , url]) => !!url).map(([key, label, url]) => ({ key, label, url: url as string }));
}

/** Resolve a catalog item from a Stripe price id — lets us credit purchases that
 *  arrive WITHOUT our metadata.key (e.g. a Payment Link created in the Stripe
 *  dashboard and shared over email/WhatsApp). The price id is the stable join. */
export function catalogByPrice(priceId?: string | null): { key: string; item: CatalogItem } | null {
  if (!priceId) return null;
  const hit = Object.entries(CATALOG).find(([, v]) => v.price === priceId);
  return hit ? { key: hit[0], item: hit[1] } : null;
}
