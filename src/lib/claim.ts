import { createServiceClient } from "@/lib/supabase/server";
import { startTimeTrial } from "@/lib/credits";

/**
 * Report-link CLAIM (P1): bind a public `/r/[token]` report to the account that
 * signs up through it. Transfers the pre-provisioned workspace from our org to the
 * claimer's org and starts their 15-day trial — so they land on a dashboard that
 * already knows their store and rivals (zero setup). Idempotent + defensive.
 */

export const CLAIM_COOKIE = "ar_claim";
export const TRIAL_DAYS = 15;

export type ClaimResult =
  | { ok: true; workspaceId: string; already: boolean }
  | { ok: false; reason: "not_found" | "expired" | "already_claimed" | "transfer_failed" };

export async function claimWorkspace(userId: string, orgId: string, token: string): Promise<ClaimResult> {
  const svc = createServiceClient();
  const { data: share } = await svc
    .from("report_share")
    .select("id, workspace_id, status, claimed_by, expires_at")
    .eq("token", token)
    .maybeSingle();
  if (!share || share.status !== "active") return { ok: false, reason: "not_found" };
  if (share.expires_at && new Date(share.expires_at as string).getTime() < Date.now()) return { ok: false, reason: "expired" };
  if (share.claimed_by && share.claimed_by !== userId) return { ok: false, reason: "already_claimed" };

  const workspaceId = share.workspace_id as string;
  const already = share.claimed_by === userId;

  // Transfer the workspace to the claimer's org (RLS scopes it by organization_id).
  const { error: tErr } = await svc.from("workspace").update({ organization_id: orgId }).eq("id", workspaceId);
  if (tErr) return { ok: false, reason: "transfer_failed" };

  // Keep the append-only analytics rows consistent with the new owner (best-effort).
  await svc.from("market_snapshot").update({ organization_id: orgId }).eq("workspace_id", workspaceId).then(() => {}, () => {});
  await svc.from("market_event").update({ organization_id: orgId }).eq("workspace_id", workspaceId).then(() => {}, () => {});

  if (!already) {
    await svc.from("report_share").update({ claimed_by: userId, claimed_at: new Date().toISOString() }).eq("id", share.id);
  }
  await startTimeTrial(orgId, TRIAL_DAYS);
  return { ok: true, workspaceId, already };
}
