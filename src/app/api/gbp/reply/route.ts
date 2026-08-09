import { NextResponse } from "next/server";
import { requireOrg, unauthorized, badRequest } from "@/lib/api";
import { activeWorkspace } from "@/lib/workspace";
import { getConnection, replyToReview } from "@/lib/gbp";

export const dynamic = "force-dynamic";

/** Post the owner's reply to one of their Google reviews — the "Act on it" loop
 *  actually sending, not just drafting. User-initiated (a button click); this
 *  publishes public content, so it only ever runs on explicit request. */
export async function POST(req: Request) {
  const auth = await requireOrg();
  if (!auth) return unauthorized();
  const { reviewName, comment } = await req.json().catch(() => ({}));
  if (!reviewName || typeof reviewName !== "string" || !/\/reviews\//.test(reviewName)) return badRequest("valid reviewName required");
  if (!comment || typeof comment !== "string" || comment.trim().length < 2) return badRequest("comment required");

  const state = await activeWorkspace();
  if (state.status !== "ok") return badRequest("no workspace");
  const conn = await getConnection(state.workspace.id);
  if (!conn?.refreshToken) return NextResponse.json({ error: "Google Business Profile isn't connected.", connected: false }, { status: 400 });

  try {
    await replyToReview(conn.refreshToken, reviewName, comment.trim());
    return NextResponse.json({ posted: true });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
