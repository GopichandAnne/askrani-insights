import { NextResponse } from "next/server";
import { createClient, createServiceClient } from "@/lib/supabase/server";
import { canManageBusiness } from "@/lib/channels";
import { findSocialHandles, reverseGeoCity } from "@/lib/social-discovery";
import { extractCity } from "@/lib/news";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

/** Re-run automatic social handle discovery for one business (the same geo-guarded
 *  name search the collector uses) — a one-click "try again" when mapping missed. */
export async function POST(req: Request) {
  const { businessId } = await req.json().catch(() => ({}));
  if (!businessId) return NextResponse.json({ error: "businessId required" }, { status: 400 });
  if (!(await canManageBusiness(businessId))) return NextResponse.json({ error: "not allowed" }, { status: 403 });

  const supabase = await createClient();
  const { data: biz } = await supabase.from("business").select("canonical_name,attributes").eq("id", businessId).maybeSingle();
  if (!biz) return NextResponse.json({ error: "not found" }, { status: 404 });

  const { data: existing } = await supabase.from("external_identity").select("platform").eq("business_id", businessId);
  const haveIg = (existing ?? []).some((i: any) => i.platform === "instagram");
  const haveFb = (existing ?? []).some((i: any) => i.platform === "facebook");
  if (haveIg && haveFb) return NextResponse.json({ found: [], message: "Instagram and Facebook already monitored." });

  const attrs = ((biz as any).attributes ?? {}) as { address?: string; geo?: { lat: number; lng: number } };
  let city = extractCity(attrs.address);
  if (!city && attrs.geo) city = await reverseGeoCity(attrs.geo);
  if (!city) {
    return NextResponse.json({ found: [], message: "No location on record — add the handle manually below." });
  }

  const found = await findSocialHandles((biz as any).canonical_name, city, { instagram: !haveIg, facebook: !haveFb });
  const svc = createServiceClient();
  const added: { platform: string; url: string }[] = [];
  for (const [platform, url] of Object.entries(found)) {
    if (platform === "searched" || !url || typeof url !== "string") continue;
    await svc.from("external_identity").insert({ business_id: businessId, platform, url, verification_state: "observed" }).then(() => {}, () => {});
    added.push({ platform, url });
  }
  return NextResponse.json({
    found: added,
    message: added.length ? `Found ${added.length} handle${added.length === 1 ? "" : "s"}.` : "Couldn't find a confident match — add it manually below.",
  });
}
