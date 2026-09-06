import { createServiceClient } from "@/lib/supabase/server";

/**
 * Competitor-label writer — banks the owner's confirm/remove/add feedback as
 * labeled Competitive Relationship Data (see migration 0074). Append-only,
 * best-effort (never blocks the UX). This is the raw material that later lets us
 * LEARN the discovery weights instead of guessing them.
 */
type Svc = ReturnType<typeof createServiceClient>;

export type CompetitorLabelKind = "confirmed" | "rejected" | "added";
export type RejectReason = "different_customers" | "too_far" | "different_price" | "different_concept" | "other";

export interface LabelInput {
  workspaceId: string;
  organizationId: string | null;
  subjectBusinessId: string | null;
  competitorBusinessId?: string | null;
  competitorName?: string | null;
  label: CompetitorLabelKind;
  reason?: RejectReason | null;
  vertical?: string | null;
  createdBy?: string | null;
}

export async function recordCompetitorLabel(svc: Svc, l: LabelInput): Promise<void> {
  await svc.from("competitor_label").insert({
    workspace_id: l.workspaceId,
    organization_id: l.organizationId,
    subject_business_id: l.subjectBusinessId,
    competitor_business_id: l.competitorBusinessId ?? null,
    competitor_name: l.competitorName ?? null,
    label: l.label,
    reason: l.reason ?? null,
    vertical: l.vertical ?? null,
    created_by: l.createdBy ?? null,
  }).then(() => {}, () => {});
}
