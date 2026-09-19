import { notFound } from "next/navigation";
import type { Metadata } from "next";
import { createServiceClient } from "@/lib/supabase/server";
import { buildPublicReport } from "@/lib/reportpage";
import { PublicReport } from "./PublicReport";

/**
 * Public shareable market-read: `insights.askrani.ai/r/<token>`. No login — the
 * lead magnet. Looks the token up (service role, since there's no user session),
 * renders the read-only report from the workspace's cached goals, and offers a
 * claim CTA. Token binding/transfer is P1 (see docs/REPORT-LINK-SPEC.md).
 */
export const dynamic = "force-dynamic";

type Params = { params: Promise<{ token: string }> };

async function loadShare(token: string) {
  const svc = createServiceClient();
  const { data: share } = await svc
    .from("report_share")
    .select("id, workspace_id, status, expires_at, view_count")
    .eq("token", token)
    .maybeSingle();
  if (!share || share.status !== "active") return null;
  if (share.expires_at && new Date(share.expires_at).getTime() < Date.now()) return null;
  return share as { id: string; workspace_id: string; status: string; expires_at: string | null; view_count: number };
}

export async function generateMetadata({ params }: Params): Promise<Metadata> {
  const { token } = await params;
  const share = await loadShare(token);
  if (!share) return { title: "Report not found", robots: { index: false, follow: false } };
  const svc = createServiceClient();
  const { data: ws } = await svc.from("workspace").select("name").eq("id", share.workspace_id).maybeSingle();
  const name = (ws?.name as string) || "Your business";
  return {
    title: `${name} — your market read`,
    description: `A live read on ${name}'s local market: where you stand, what rivals are charging, and your next move. By Ask Rani Insights.`,
    robots: { index: false, follow: false },
    openGraph: { title: `${name} — your market read`, description: "Where you stand, what rivals are charging, and your next move.", type: "website" },
  };
}

export default async function ReportSharePage({ params }: Params) {
  const { token } = await params;
  const share = await loadShare(token);
  if (!share) notFound();

  const svc = createServiceClient();
  const { data: ws } = await svc
    .from("workspace")
    .select("name, vertical, goals")
    .eq("id", share.workspace_id)
    .maybeSingle();
  if (!ws) notFound();

  // Review counts by business name from the latest market snapshot (for standings).
  const reviewCountByName: Record<string, number | null> = {};
  const { data: snaps } = await svc
    .from("market_snapshot")
    .select("business_id, review_count, captured_on")
    .eq("workspace_id", share.workspace_id)
    .order("captured_on", { ascending: false })
    .limit(60);
  if (snaps?.length) {
    const latestDay = snaps[0].captured_on;
    const latest = snaps.filter((s: any) => s.captured_on === latestDay);
    const ids = [...new Set(latest.map((s: any) => s.business_id))];
    const { data: biz } = await svc.from("business").select("id, canonical_name").in("id", ids);
    const nameById = new Map<string, string>((biz ?? []).map((b: any) => [b.id as string, b.canonical_name as string] as [string, string]));
    for (const s of latest) {
      const name = nameById.get(s.business_id);
      if (name) reviewCountByName[name] = (s.review_count as number | null) ?? null;
    }
  }

  const data = buildPublicReport(
    { name: ws.name as string, vertical: (ws.vertical as string) || "business" },
    (ws.goals as Record<string, any>) ?? {},
    reviewCountByName,
    new Date(),
  );

  // Best-effort view count bump (never blocks render).
  svc.from("report_share").update({ view_count: (share.view_count ?? 0) + 1 }).eq("id", share.id).then(() => {}, () => {});

  const claimHref = `/login?claim=${encodeURIComponent(token)}&mode=signup`;
  return <PublicReport data={data} claimHref={claimHref} />;
}
