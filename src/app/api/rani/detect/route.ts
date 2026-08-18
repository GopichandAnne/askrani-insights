import { NextResponse } from "next/server";
import { detectBusiness, type DetectKind } from "@/lib/detect";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 20;

/**
 * Governed business auto-detect for Rani's onboarding (the "outside" umbrella
 * lending its discovery to the "inside" product). Rani's `detect-business` edge
 * function calls this with the shared secret; we resolve the business from a single
 * identifier (address → Google Place + hours; website → homepage read) and hand
 * back the basics so Rani's interview can CONFIRM instead of interrogate.
 *
 * Same shared-secret contract as ops-slice / wallet / transcribe. Aggregate,
 * public data only — no workspace, no customer PII. Un-metered by design: this is
 * an onboarding cost we choose to eat to make setup one question long.
 */
export async function POST(req: Request) {
  const authz = req.headers.get("authorization") ?? "";
  const bearer = authz.startsWith("Bearer ") ? authz.slice(7) : "";
  const provided = req.headers.get("x-ops-secret") ?? bearer;
  // Accept the shared umbrella secret OR a dedicated public-detect secret. The
  // latter lets the marketing site authenticate with its own value, decoupled
  // from the shared ops secret (no need to reuse/recover it).
  const shared = process.env.RANI_OPS_SECRET;
  const webSecret = process.env.WEB_DETECT_SECRET;
  const ok = !!provided && ((!!shared && provided === shared) || (!!webSecret && provided === webSecret));
  if (!ok) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  let body: { kind?: string; query?: string; name?: string };
  try { body = await req.json(); } catch { return NextResponse.json({ error: "bad json" }, { status: 400 }); }

  const kind: DetectKind = body.kind === "online" ? "online" : "local";
  const query = String(body.query ?? "").trim();
  if (!query) return NextResponse.json({ error: "query required" }, { status: 400 });

  try {
    const { detected, source } = await detectBusiness({ kind, query, name: body.name });
    return NextResponse.json({ ok: true, kind, detected, source });
  } catch (e) {
    console.error("[rani/detect]", (e as Error).message);
    // Fail-soft — onboarding continues without the auto-fill.
    return NextResponse.json({ ok: true, kind, detected: null, source: "none" });
  }
}
