import { NextResponse } from "next/server";
import { requireOrg } from "@/lib/api";
import { activeWorkspace } from "@/lib/workspace";
import { gbpConfigured, authUrl } from "@/lib/gbp";

export const dynamic = "force-dynamic";

/** Kick off the Google Business Profile OAuth consent for the active workspace. */
export async function GET(req: Request) {
  const auth = await requireOrg();
  if (!auth) return NextResponse.redirect(new URL("/login?next=/channels", req.url));
  if (!gbpConfigured()) return NextResponse.json({ error: "Google Business Profile isn't set up yet (GBP_CLIENT_ID/SECRET)." }, { status: 503 });
  const state = await activeWorkspace();
  if (state.status !== "ok") return NextResponse.redirect(new URL("/onboarding", req.url));
  const stateParam = Buffer.from(JSON.stringify({ w: state.workspace.id, o: auth.orgId })).toString("base64url");
  return NextResponse.redirect(authUrl(stateParam));
}
