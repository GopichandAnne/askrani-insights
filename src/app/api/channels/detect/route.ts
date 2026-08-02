import { NextResponse } from "next/server";
import { createClient, createServiceClient } from "@/lib/supabase/server";
import { canManageBusiness } from "@/lib/channels";
import { findSocialHandles, findDeliveryUrls, reverseGeoCity } from "@/lib/social-discovery";
import { extractCity } from "@/lib/news";
import { platformActorConfigured } from "@/lib/providers/apify/platforms";

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
  const has = (p: string) => (existing ?? []).some((i: any) => i.platform === p);
  const wantIg = !has("instagram"), wantFb = !has("facebook"), wantTt = !has("tiktok");
  const wantDd = !has("doordash") && platformActorConfigured("doordash");
  const wantUe = !has("ubereats") && platformActorConfigured("ubereats");
  if (!wantIg && !wantFb && !wantTt && !wantDd && !wantUe) {
    return NextResponse.json({ found: [], message: "All available channels are already monitored." });
  }

  const attrs = ((biz as any).attributes ?? {}) as { address?: string; geo?: { lat: number; lng: number } };
  let city = extractCity(attrs.address);
  if (!city && attrs.geo) city = await reverseGeoCity(attrs.geo);
  if (!city) {
    return NextResponse.json({ found: [], message: "No location on record — add the handle manually below." });
  }

  const name = (biz as any).canonical_name as string;
  const [social, delivery] = await Promise.all([
    (wantIg || wantFb || wantTt) ? findSocialHandles(name, city, { instagram: wantIg, facebook: wantFb, tiktok: wantTt }) : Promise.resolve({ searched: false } as any),
    (wantDd || wantUe) ? findDeliveryUrls(name, city, { doordash: wantDd, ubereats: wantUe }) : Promise.resolve({ searched: false } as any),
  ]);
  const svc = createServiceClient();
  const added: { platform: string; url: string }[] = [];
  for (const src of [social, delivery]) {
    for (const [platform, url] of Object.entries(src)) {
      if (platform === "searched" || !url || typeof url !== "string") continue;
      await svc.from("external_identity").insert({ business_id: businessId, platform, url, verification_state: "observed" }).then(() => {}, () => {});
      added.push({ platform, url });
    }
  }
  return NextResponse.json({
    found: added,
    message: added.length ? `Found ${added.length} channel${added.length === 1 ? "" : "s"}.` : "Couldn't find a confident match — add it manually below.",
  });
}
