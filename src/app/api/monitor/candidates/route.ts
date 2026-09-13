import { NextResponse } from "next/server";
import { requireOrg, unauthorized } from "@/lib/api";
import { getUser, isSuperAdmin } from "@/lib/auth";
import { loadCandidates, saveCandidates, sanitizeCandidates } from "@/lib/monitor-candidates";

export const dynamic = "force-dynamic";

/** Superadmin-only. GET returns the saved monitoring-candidate list (or the default);
 *  PUT persists the whole list so handle/facet corrections survive a reload. */
export async function GET() {
  const auth = await requireOrg();
  if (!auth) return unauthorized();
  if (!isSuperAdmin(await getUser())) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  return NextResponse.json({ candidates: await loadCandidates() });
}

export async function PUT(req: Request) {
  const auth = await requireOrg();
  if (!auth) return unauthorized();
  if (!isSuperAdmin(await getUser())) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  const body = await req.json().catch(() => ({}));
  const candidates = sanitizeCandidates(body.candidates);
  if (!candidates.length) return NextResponse.json({ error: "no candidates" }, { status: 400 });
  const saved = await saveCandidates(candidates);
  return NextResponse.json({ ok: saved, saved: candidates.length });
}
