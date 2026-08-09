import { NextResponse } from "next/server";
import { requireOrg } from "@/lib/api";
import { workspaceInOrg } from "@/lib/api";
import { gbpConfigured, exchangeCode, discoverLocation, saveConnection } from "@/lib/gbp";

export const dynamic = "force-dynamic";

/** OAuth callback: exchange the code, auto-pick the owner's location, and store
 *  the connection on the workspace. Membership is re-verified from the session —
 *  the state param is a convenience, not the trust anchor. */
export async function GET(req: Request) {
  const url = new URL(req.url);
  const done = (q: string) => NextResponse.redirect(new URL(`/channels?gbp=${q}`, req.url));
  if (url.searchParams.get("error")) return done("denied");
  const code = url.searchParams.get("code");
  const stateRaw = url.searchParams.get("state") ?? "";
  if (!code) return done("error");
  if (!gbpConfigured()) return done("error");

  const auth = await requireOrg();
  if (!auth) return NextResponse.redirect(new URL("/login?next=/channels", req.url));

  let workspaceId = "";
  try { workspaceId = JSON.parse(Buffer.from(stateRaw, "base64url").toString()).w; } catch { /* ignore */ }
  if (!workspaceId || !(await workspaceInOrg(workspaceId, auth.orgId))) return done("error");

  try {
    const tok = await exchangeCode(code);
    if (!tok.refresh_token) return done("norefresh"); // happens if the user already granted before without revoking
    const loc = await discoverLocation(tok.access_token);
    if (!loc) return done("nolocation");
    await saveConnection(workspaceId, {
      refreshToken: tok.refresh_token,
      accountName: loc.accountName,
      locationPath: loc.locationPath,
      title: loc.title,
      connectedAt: new Date().toISOString(),
    });
    return done("connected");
  } catch {
    return done("error");
  }
}
