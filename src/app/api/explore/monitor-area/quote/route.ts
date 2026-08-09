import { NextResponse } from "next/server";
import { requireOrg, unauthorized } from "@/lib/api";
import { quoteAreaMonitor, getBalance } from "@/lib/credits";

export const dynamic = "force-dynamic";

/**
 * Quote the up-front cost to start monitoring an area — cheap (no scan): the
 * client passes how many businesses the free Explore already found, we price it
 * (base + per-business, capped) and return the org's balance so the confirm strip
 * can show "N credits · balance B". The RUN endpoint re-scans and charges the
 * authoritative amount.
 */
export async function POST(req: Request) {
  const auth = await requireOrg();
  if (!auth) return unauthorized();
  const body = await req.json().catch(() => ({}));
  const businessCount = Math.max(0, Math.min(50, Number(body.businessCount) || 0));
  const quote = quoteAreaMonitor(businessCount);
  return NextResponse.json({ quote, businessCount, balance: await getBalance(auth.orgId) });
}
