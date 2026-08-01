import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { createClient } from "@/lib/supabase/server";
import { ACTIVE_WS_COOKIE } from "@/lib/workspace";

export const dynamic = "force-dynamic";

/** Remember which business (workspace) the user is viewing. RLS ensures the id
 *  must belong to the caller before we persist it. */
export async function POST(req: Request) {
  const { workspaceId } = await req.json().catch(() => ({ workspaceId: null }));
  if (!workspaceId || typeof workspaceId !== "string") {
    return NextResponse.json({ error: "workspaceId required" }, { status: 400 });
  }
  const supabase = await createClient();
  const { data } = await supabase.from("workspace").select("id").eq("id", workspaceId).maybeSingle();
  if (!data) return NextResponse.json({ error: "not found" }, { status: 404 });

  (await cookies()).set(ACTIVE_WS_COOKIE, workspaceId, {
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    maxAge: 60 * 60 * 24 * 365,
  });
  return NextResponse.json({ ok: true });
}
