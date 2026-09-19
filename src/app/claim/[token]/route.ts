import { NextResponse } from "next/server";
import { getUser, ensureOrgForUser } from "@/lib/auth";
import { claimWorkspace, CLAIM_COOKIE } from "@/lib/claim";

/**
 * Entry point for "Claim your dashboard" on a public /r/[token] report.
 *  - Signed OUT → stash the token in a short-lived cookie and send to sign-up;
 *    the claim then runs at /api/profile/complete once their org exists.
 *  - Signed IN  → run the claim immediately (org is ensured) and drop them into
 *    the app on their now-owned workspace.
 * See docs/REPORT-LINK-SPEC.md.
 */
export const dynamic = "force-dynamic";

export async function GET(req: Request, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const origin = new URL(req.url).origin;
  const user = await getUser();

  if (user) {
    try {
      const orgId = await ensureOrgForUser(user.id, user.email ?? null);
      await claimWorkspace(user.id, orgId, token);
    } catch { /* fall through — still send them into the app */ }
    return NextResponse.redirect(new URL("/brief", origin)); // Today, not setup
  }

  const res = NextResponse.redirect(new URL("/login?mode=signup", origin));
  res.cookies.set(CLAIM_COOKIE, token, { path: "/", maxAge: 3600, sameSite: "lax", httpOnly: true });
  return res;
}
