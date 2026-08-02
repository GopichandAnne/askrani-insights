import { NextResponse } from "next/server";
import { requireOrg } from "@/lib/api";
import { isStripeConfigured, stripe } from "@/lib/stripe";
import { getStripeCustomer } from "@/lib/credits";

export const dynamic = "force-dynamic";

/** Stripe Customer Portal — manage/cancel subscription, update card. */
export async function POST(req: Request) {
  if (!isStripeConfigured()) return NextResponse.json({ error: "Billing isn't set up yet." }, { status: 503 });
  const auth = await requireOrg();
  if (!auth) return NextResponse.json({ error: "sign in" }, { status: 401 });
  const customer = await getStripeCustomer(auth.orgId);
  if (!customer) return NextResponse.json({ error: "No billing account yet — buy a plan first." }, { status: 400 });
  try {
    const session = await stripe().billingPortal.sessions.create({
      customer,
      return_url: `${new URL(req.url).origin}/billing`,
    });
    return NextResponse.json({ url: session.url });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
