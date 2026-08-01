import { NextResponse } from "next/server";
import { createClient, createServiceClient } from "@/lib/supabase/server";
import { canManageBusiness } from "@/lib/channels";

export const dynamic = "force-dynamic";

/** Stop monitoring a channel. Verifies the identity belongs to a business the
 *  caller manages before the service client deletes it. */
export async function POST(req: Request) {
  const { identityId } = await req.json().catch(() => ({}));
  if (!identityId) return NextResponse.json({ error: "identityId required" }, { status: 400 });

  const supabase = await createClient();
  const { data: ident } = await supabase.from("external_identity").select("id,business_id").eq("id", identityId).maybeSingle();
  if (!ident) return NextResponse.json({ error: "not found" }, { status: 404 });
  if (!(await canManageBusiness((ident as any).business_id))) return NextResponse.json({ error: "not allowed" }, { status: 403 });

  const svc = createServiceClient();
  const { error } = await svc.from("external_identity").delete().eq("id", identityId);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}
