import { NextResponse } from "next/server";
import { demoAnswer } from "@/lib/detect";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 20;

/**
 * Grader live demo — answer a visitor's question from a graded site's public
 * content, so they can try Rani before signing up. Same shared-secret contract as
 * the other rani/* ops; the marketing site's rate-limited proxy calls it.
 */
export async function POST(req: Request) {
  const authz = req.headers.get("authorization") ?? "";
  const bearer = authz.startsWith("Bearer ") ? authz.slice(7) : "";
  const provided = req.headers.get("x-ops-secret") ?? bearer;
  const shared = process.env.RANI_OPS_SECRET;
  const webSecret = process.env.WEB_DETECT_SECRET;
  const ok = !!provided && ((!!shared && provided === shared) || (!!webSecret && provided === webSecret));
  if (!ok) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  let body: { url?: string; question?: string };
  try { body = await req.json(); } catch { return NextResponse.json({ error: "bad json" }, { status: 400 }); }

  const url = String(body.url ?? "").trim();
  const question = String(body.question ?? "").trim();
  if (!url || !question) return NextResponse.json({ error: "url and question required" }, { status: 400 });

  try {
    const res = await demoAnswer(url, question);
    if (!res) return NextResponse.json({ ok: false, reason: "unavailable" });
    return NextResponse.json({ ok: true, answer: res.answer });
  } catch (e) {
    console.error("[rani/demo]", (e as Error).message);
    return NextResponse.json({ ok: false, reason: "error" });
  }
}
