import { NextResponse } from "next/server";
import { requireOrg } from "@/lib/api";
import { getUser } from "@/lib/auth";
import { isStripeConfigured, stripe, CATALOG, resolvePriceId } from "@/lib/stripe";
import { getStripeCustomer, setStripeCustomer } from "@/lib/credits";

export const dynamic = "force-dynamic";

/** Create a Stripe Checkout Session for a plan subscription or a credit top-up. */
export async function POST(req: Request) {
  if (!isStripeConfigured()) return NextResponse.json({ error: "Billing isn't set up yet." }, { status: 503 });
  const auth = await requireOrg();
  if (!auth) return NextResponse.json({ error: "sign in" }, { status: 401 });

  const { key } = await req.json().catch(() => ({}));
  const item = CATALOG[String(key)];
  if (!item?.price) return NextResponse.json({ error: "That option isn't available." }, { status: 400 });
  const priceId = await resolvePriceId(item.price);
  if (!priceId) return NextResponse.json({ error: "That price isn't set up in Stripe yet." }, { status: 400 });

  const origin = new URL(req.url).origin;
  const s = stripe();
  try {
    // reuse or create the org's Stripe customer
    let customer = await getStripeCustomer(auth.orgId);
    if (!customer) {
      const user = await getUser();
      const created = await s.customers.create({ email: user?.email ?? undefined, metadata: { orgId: auth.orgId } });
      customer = created.id;
      await setStripeCustomer(auth.orgId, customer);
    }
    const session = await s.checkout.sessions.create({
      mode: item.mode,
      customer,
      line_items: [{ price: priceId, quantity: 1 }],
      client_reference_id: auth.orgId,
      metadata: { orgId: auth.orgId, key: String(key) },
      success_url: `${origin}/billing?purchase=success`,
      cancel_url: `${origin}/billing?purchase=cancelled`,
      allow_promotion_codes: true,
    });
    return NextResponse.json({ url: session.url });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
