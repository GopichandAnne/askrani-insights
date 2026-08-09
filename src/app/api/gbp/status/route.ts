import { NextResponse } from "next/server";
import { requireOrg, unauthorized } from "@/lib/api";
import { activeWorkspace } from "@/lib/workspace";
import { gbpConfigured, getConnection } from "@/lib/gbp";

export const dynamic = "force-dynamic";

/** Connection status for the active workspace — drives the connect UI and the
 *  "Post to Google" affordance in Act-on-it. */
export async function GET() {
  const auth = await requireOrg();
  if (!auth) return unauthorized();
  const configured = gbpConfigured();
  const state = await activeWorkspace();
  if (state.status !== "ok") return NextResponse.json({ configured, connected: false });
  const conn = await getConnection(state.workspace.id);
  return NextResponse.json({
    configured,
    connected: !!conn?.refreshToken,
    title: conn?.title ?? null,
    lastSync: conn?.lastSync ?? null,
    reviewCount: conn?.reviewCount ?? null,
  });
}
