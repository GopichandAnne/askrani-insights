import { NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/server";
import { canManageBusiness, normalizeSocial, PLATFORM_META } from "@/lib/channels";

export const dynamic = "force-dynamic";

/** Manually attach a social/website channel to a business (used when automatic
 *  handle-mapping misses). Marked owner_verified — the owner told us it's theirs. */
export async function POST(req: Request) {
  const { businessId, platform, url } = await req.json().catch(() => ({}));
  if (!businessId || !platform || !url) return NextResponse.json({ error: "businessId, platform and url required" }, { status: 400 });
  if (!PLATFORM_META[platform]) return NextResponse.json({ error: "unknown platform" }, { status: 400 });
  if (!(await canManageBusiness(businessId))) return NextResponse.json({ error: "not allowed" }, { status: 403 });

  const norm = normalizeSocial(platform, url);
  if (!norm) return NextResponse.json({ error: "couldn't read that handle — paste the profile link" }, { status: 400 });

  const svc = createServiceClient();
  // upsert on the (business, platform, coalesce(external_id,url,handle)) unique index
  const { data, error } = await svc
    .from("external_identity")
    .upsert(
      { business_id: businessId, platform, url: norm.url, handle: norm.handle, verification_state: "owner_verified" },
      { onConflict: "business_id,platform,url", ignoreDuplicates: false },
    )
    .select("id,platform,url,handle,verification_state")
    .maybeSingle();

  if (error) {
    // fall back to a plain insert if the upsert target index name differs
    const ins = await svc
      .from("external_identity")
      .insert({ business_id: businessId, platform, url: norm.url, handle: norm.handle, verification_state: "owner_verified" })
      .select("id,platform,url,handle,verification_state")
      .maybeSingle();
    if (ins.error) return NextResponse.json({ error: ins.error.message }, { status: 500 });
    return NextResponse.json({ identity: ins.data });
  }
  return NextResponse.json({ identity: data });
}
