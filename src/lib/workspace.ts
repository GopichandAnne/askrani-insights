import { createClient } from "@/lib/supabase/server";
import { getUser, isSupabaseConfigured } from "@/lib/auth";

/**
 * Read-side helpers for the signed-in user's active workspace. All queries go
 * through the RLS client, so tenant isolation is enforced by the database, not
 * by these functions (guide 13.1).
 */

export interface WorkspaceRow {
  id: string;
  name: string;
  vertical: string;
  target_business_id: string | null;
}

export type ScreenState =
  | { status: "unconfigured" }
  | { status: "signedout" }
  | { status: "empty" }
  | { status: "ok"; workspace: WorkspaceRow };

/** The most recently created workspace for the current user, or a reason why not. */
export async function activeWorkspace(): Promise<ScreenState> {
  if (!isSupabaseConfigured()) return { status: "unconfigured" };
  const user = await getUser();
  if (!user) return { status: "signedout" };

  const supabase = await createClient();
  const { data } = await supabase
    .from("workspace")
    .select("id,name,vertical,target_business_id")
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (!data) return { status: "empty" };
  return { status: "ok", workspace: data as WorkspaceRow };
}

/** Business ids in a workspace: the target plus its competitor edges. */
export async function workspaceBusinessIds(ws: WorkspaceRow): Promise<{
  targetId: string | null;
  competitorIds: string[];
  all: string[];
}> {
  const supabase = await createClient();
  const { data: edges } = await supabase
    .from("competitor_edge")
    .select("competitor_id")
    .eq("workspace_id", ws.id);
  const competitorIds = (edges ?? []).map((e) => e.competitor_id as string);
  const all = [ws.target_business_id, ...competitorIds].filter(Boolean) as string[];
  return { targetId: ws.target_business_id, competitorIds, all };
}
