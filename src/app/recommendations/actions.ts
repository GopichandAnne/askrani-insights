"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";

/**
 * Update a recommendation's status. RLS (recommendation_rw → is_workspace_member)
 * ensures only members of the owning workspace can act. Dismissals capture a
 * reason (guide 10.4: "record dismissal reasons").
 */
export async function setRecommendationStatus(formData: FormData) {
  const id = String(formData.get("id") ?? "");
  const status = String(formData.get("status") ?? "");
  const reason = String(formData.get("reason") ?? "") || null;
  if (!id || !["saved", "approved", "launched", "dismissed"].includes(status)) return;

  const supabase = await createClient();
  await supabase
    .from("recommendation")
    .update({ status, dismissal_reason: status === "dismissed" ? reason : null })
    .eq("id", id);
  revalidatePath("/recommendations");
}
