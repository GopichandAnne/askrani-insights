import { NextResponse } from "next/server";
import { probeAnswerEngines } from "@/lib/probe";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 60;

/**
 * Proof B engine — asks a live answer engine (Perplexity) real questions about a
 * business and returns the verbatim answers + whether it answered and cited the
 * business. Ask Rani calls this before/after publishing an Answers page to build
 * an evidenced before→after. Same shared-secret contract as the other rani/* ops.
 * Returns { ok:false, reason:"unconfigured" } when PERPLEXITY_API_KEY is unset.
 */
export async function POST(req: Request) {
  const authz = req.headers.get("authorization") ?? "";
  const bearer = authz.startsWith("Bearer ") ? authz.slice(7) : "";
  const provided = req.headers.get("x-ops-secret") ?? bearer;
  const shared = process.env.RANI_OPS_SECRET;
  const webSecret = process.env.WEB_DETECT_SECRET;
  const ok = !!provided && ((!!shared && provided === shared) || (!!webSecret && provided === webSecret));
  if (!ok) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  let body: { name?: string; siteUrl?: string; answersUrl?: string; questions?: unknown };
  try { body = await req.json(); } catch { return NextResponse.json({ error: "bad json" }, { status: 400 }); }

  const name = String(body.name ?? "").trim();
  const questions = Array.isArray(body.questions)
    ? body.questions.map((q) => String(q ?? "").trim()).filter(Boolean)
    : [];
  if (!name || !questions.length) return NextResponse.json({ error: "name and questions required" }, { status: 400 });

  try {
    const results = await probeAnswerEngines({
      name,
      siteUrl: body.siteUrl ? String(body.siteUrl) : undefined,
      answersUrl: body.answersUrl ? String(body.answersUrl) : undefined,
      questions,
    });
    if (results === null) return NextResponse.json({ ok: false, reason: "unconfigured" });
    return NextResponse.json({ ok: true, results });
  } catch (e) {
    console.error("[rani/probe]", (e as Error).message);
    return NextResponse.json({ ok: false, reason: "error" });
  }
}
