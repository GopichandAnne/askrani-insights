import { NextResponse } from "next/server";
import { requireOrg } from "@/lib/api";
import { creditsSummary } from "@/lib/credits";

export const dynamic = "force-dynamic";

/** Current org's credit balance + recent usage (Phase 1: read-only). */
export async function GET() {
  const auth = await requireOrg();
  if (!auth) return NextResponse.json({ error: "sign in" }, { status: 401 });
  return NextResponse.json(await creditsSummary(auth.orgId));
}
