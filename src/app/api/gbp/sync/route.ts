import { NextResponse } from "next/server";
import { requireOrg, unauthorized } from "@/lib/api";
import { activeWorkspace } from "@/lib/workspace";
import { createServiceClient } from "@/lib/supabase/server";
import { getConnection, listReviews, saveConnection } from "@/lib/gbp";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/** Pull ALL of the owner's Google reviews (50/page) into content_item so every
 *  review pillar (reputation/demand) reads the full set — not the ≈5 the public
 *  Places API caps at. Stored under platform "google" (external_ref = review
 *  name) so they merge cleanly with existing rows. */
export async function POST() {
  const auth = await requireOrg();
  if (!auth) return unauthorized();
  const state = await activeWorkspace();
  if (state.status !== "ok") return NextResponse.json({ error: "no workspace" }, { status: 400 });
  const ws = state.workspace;
  if (!ws.target_business_id) return NextResponse.json({ error: "no target business" }, { status: 400 });

  const conn = await getConnection(ws.id);
  if (!conn?.refreshToken) return NextResponse.json({ error: "not connected", connected: false }, { status: 400 });

  try {
    const reviews = await listReviews(conn.refreshToken, conn.locationPath);
    const svc = createServiceClient();
    const now = new Date().toISOString();
    const rows = reviews
      .filter((r) => r.name)
      .map((r) => ({
        business_id: ws.target_business_id,
        platform: "google",
        external_ref: r.name,
        provenance: "OWNER_AUTHORIZED_API",
        url: undefined,
        text: r.comment || (r.rating ? `Rated ${r.rating}★ (no comment).` : ""),
        media: [],
        published_at: r.createTime ?? null,
        observed_at: now,
      }))
      .filter((r) => r.text);
    for (let i = 0; i < rows.length; i += 200) {
      const { error } = await svc.from("content_item").upsert(rows.slice(i, i + 200), { onConflict: "platform,external_ref" });
      if (error) throw new Error(error.message);
    }
    await saveConnection(ws.id, { lastSync: now, reviewCount: reviews.length });
    return NextResponse.json({ synced: rows.length, total: reviews.length, unreplied: reviews.filter((r) => !r.replied).length });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
