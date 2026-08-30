import { NextResponse } from "next/server";
import { gradeAnswerability } from "@/lib/detect";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 30;

/**
 * Answer-readiness grader — the brain behind the public free tool. Given one URL
 * and no account, it reads the site and scores how well an AI assistant could
 * answer a real customer's questions from it: a shareable 0–100, the answerable
 * questions (the live-demo material), and the gaps (the to-do list).
 *
 * Same shared-secret contract as /api/rani/detect — the marketing site's public,
 * rate-limited proxy authenticates with WEB_DETECT_SECRET (or the shared ops
 * secret). Aggregate public data only; un-metered onboarding-class cost, but the
 * caller rate-limits + email-gates the full report to cap abuse.
 */
export async function POST(req: Request) {
  const authz = req.headers.get("authorization") ?? "";
  const bearer = authz.startsWith("Bearer ") ? authz.slice(7) : "";
  const provided = req.headers.get("x-ops-secret") ?? bearer;
  const shared = process.env.RANI_OPS_SECRET;
  const webSecret = process.env.WEB_DETECT_SECRET;
  const ok = !!provided && ((!!shared && provided === shared) || (!!webSecret && provided === webSecret));
  if (!ok) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  let body: { url?: string };
  try { body = await req.json(); } catch { return NextResponse.json({ error: "bad json" }, { status: 400 }); }

  const url = String(body.url ?? "").trim();
  if (!url) return NextResponse.json({ error: "url required" }, { status: 400 });

  try {
    const grade = await gradeAnswerability(url);
    if (!grade) return NextResponse.json({ ok: false, reason: "unreadable" });
    return NextResponse.json({ ok: true, grade });
  } catch (e) {
    console.error("[rani/grade]", (e as Error).message);
    return NextResponse.json({ ok: false, reason: "error" });
  }
}
