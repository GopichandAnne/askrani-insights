import { NextResponse } from "next/server";
import { discoveryTeaser } from "@/lib/probe";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 30;

/**
 * Grader discovery teaser — "when someone searches your category WITHOUT your
 * name, does AI recommend you, and who does it recommend instead?" A couple of
 * live engine probes, so it stays cheap on a public tool. Same shared-secret
 * contract as the other rani/* ops.
 */
export async function POST(req: Request) {
  const authz = req.headers.get("authorization") ?? "";
  const bearer = authz.startsWith("Bearer ") ? authz.slice(7) : "";
  const provided = req.headers.get("x-ops-secret") ?? bearer;
  const shared = process.env.RANI_OPS_SECRET;
  const webSecret = process.env.WEB_DETECT_SECRET;
  const ok = !!provided && ((!!shared && provided === shared) || (!!webSecret && provided === webSecret));
  if (!ok) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  let body: { name?: string; url?: string; hints?: unknown };
  try { body = await req.json(); } catch { return NextResponse.json({ error: "bad json" }, { status: 400 }); }

  const name = String(body.name ?? "").trim();
  if (!name) return NextResponse.json({ error: "name required" }, { status: 400 });
  const hints = Array.isArray(body.hints) ? body.hints.map((h) => String(h ?? "").trim()).filter(Boolean) : [];

  try {
    const res = await discoveryTeaser({ name, siteUrl: body.url ? String(body.url) : undefined, hints });
    if (!res) return NextResponse.json({ ok: false, reason: "unavailable" });
    return NextResponse.json({ ok: true, ...res });
  } catch (e) {
    console.error("[rani/discovery]", (e as Error).message);
    return NextResponse.json({ ok: false, reason: "error" });
  }
}
