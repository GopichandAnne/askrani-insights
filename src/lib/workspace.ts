import { cookies } from "next/headers";
import { createClient, type RlsClient } from "@/lib/supabase/server";
import { getUser, isSupabaseConfigured } from "@/lib/auth";

/** Cookie that remembers which business (workspace) the user is currently viewing. */
export const ACTIVE_WS_COOKIE = "ar_active_ws";

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

/**
 * The workspace the user is currently viewing. A login can watch many businesses
 * (one workspace each); we honor the one they picked (ACTIVE_WS_COOKIE) and fall
 * back to the most recently created. RLS guarantees the cookie can only ever
 * resolve to a workspace the user is a member of.
 */
export async function activeWorkspace(): Promise<ScreenState> {
  if (!isSupabaseConfigured()) return { status: "unconfigured" };
  const user = await getUser();
  if (!user) return { status: "signedout" };

  const supabase = await createClient();

  const pinned = (await cookies()).get(ACTIVE_WS_COOKIE)?.value;
  if (pinned) {
    const { data } = await supabase
      .from("workspace")
      .select("id,name,vertical,target_business_id")
      .eq("id", pinned)
      .maybeSingle();
    if (data) return { status: "ok", workspace: data as WorkspaceRow };
  }

  const { data } = await supabase
    .from("workspace")
    .select("id,name,vertical,target_business_id")
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (!data) return { status: "empty" };
  return { status: "ok", workspace: data as WorkspaceRow };
}

/** All workspaces (businesses) the signed-in user can view, newest first. */
export async function listWorkspaces(): Promise<WorkspaceRow[]> {
  if (!isSupabaseConfigured()) return [];
  const user = await getUser();
  if (!user) return [];
  const supabase = await createClient();
  const { data } = await supabase
    .from("workspace")
    .select("id,name,vertical,target_business_id")
    .order("created_at", { ascending: false });
  return (data ?? []) as WorkspaceRow[];
}

/** Business ids in a workspace: the target plus its competitor edges. */
export async function workspaceBusinessIds(ws: WorkspaceRow, db?: RlsClient): Promise<{
  targetId: string | null;
  competitorIds: string[];
  all: string[];
}> {
  const supabase = db ?? (await createClient());
  const { data: edges } = await supabase
    .from("competitor_edge")
    .select("competitor_id")
    .eq("workspace_id", ws.id);
  const competitorIds = (edges ?? []).map((e) => e.competitor_id as string);
  const all = [ws.target_business_id, ...competitorIds].filter(Boolean) as string[];
  return { targetId: ws.target_business_id, competitorIds, all };
}
