import { NextResponse } from "next/server";
import type Stripe from "stripe";
import { isStripeConfigured, stripe, CATALOG } from "@/lib/stripe";
import { grantTopup, setPlan, grantPlanCredits, markEventProcessed, orgByStripeCustomer, setStripeCustomer } from "@/lib/credits";
import { requeuePausedForOrg } from "@/lib/jobs";

export const dynamic = "force-dynamic";

/** Stripe webhook — the source of truth for grants. Verifies the signature,
 *  then: top-up payment → add credits; subscription checkout → set plan;
 *  invoice.paid → (re)grant monthly credits; subscription deleted → downgrade.
 *  Idempotent per org+event id. Configure the endpoint + STRIPE_WEBHOOK_SECRET
 *  in Stripe → Developers → Webhooks. */
export async function POST(req: Request) {
  if (!isStripeConfigured() || !process.env.STRIPE_WEBHOOK_SECRET) {
    return NextResponse.json({ error: "not configured" }, { status: 503 });
  }
  const body = await req.text();
  const sig = req.headers.get("stripe-signature") ?? "";
  let event: Stripe.Event;
  try {
    event = stripe().webhooks.constructEvent(body, sig, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (e) {
    return NextResponse.json({ error: `signature: ${(e as Error).message}` }, { status: 400 });
  }

  try {
    if (event.type === "checkout.session.completed") {
      const s = event.data.object as Stripe.Checkout.Session;
      const orgId = (s.metadata?.orgId as string) ?? (s.client_reference_id as string) ?? null;
      const item = CATALOG[String(s.metadata?.key)];
      if (orgId && s.customer) await setStripeCustomer(orgId, String(s.customer));
      if (orgId && item && (await markEventProcessed(orgId, event.id))) {
        if (s.mode === "payment" && item.credits) {
          await grantTopup(orgId, item.credits, { stripe_session: s.id, key: s.metadata?.key });
          await requeuePausedForOrg(orgId);
        } else if (s.mode === "subscription" && item.plan) {
          await setPlan(orgId, item.plan, "active"); // credits granted on invoice.paid
        }
      }
    } else if (event.type === "invoice.paid") {
      const inv = event.data.object as Stripe.Invoice;
      const orgId = inv.customer ? await orgByStripeCustomer(String(inv.customer)) : null;
      if (orgId && (await markEventProcessed(orgId, event.id))) {
        await grantPlanCredits(orgId); // reset monthly allotment
        await requeuePausedForOrg(orgId);
      }
    } else if (event.type === "customer.subscription.deleted") {
      const sub = event.data.object as Stripe.Subscription;
      const orgId = sub.customer ? await orgByStripeCustomer(String(sub.customer)) : null;
      if (orgId) await setPlan(orgId, "free", "canceled");
    }
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
  return NextResponse.json({ received: true });
}
