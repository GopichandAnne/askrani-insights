import type { SupabaseClient } from "@supabase/supabase-js";
import type { AssistantAction } from "@/lib/assistant";

/**
 * Execute a copilot action against the caller's OWN workspace. The advisor brain
 * (answerFromData) only DECIDES the action; this runs it. `svc` is the service
 * client; `ws.id` must already be verified to belong to the signed-in user (the
 * chat route uses activeWorkspace, which scopes to the user's workspace).
 * Every action is a small, safe config write (no credit spend).
 */

const slugify = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

export async function applyAssistantAction(
  svc: SupabaseClient,
  ws: { id: string },
  action: AssistantAction,
): Promise<{ ok: boolean; note?: string }> {
  async function setGoal(patch: Record<string, unknown>) {
    const { data } = await svc.from("workspace").select("goals").eq("id", ws.id).maybeSingle();
    const goals = ((data?.goals as Record<string, unknown>) ?? {});
    await svc.from("workspace").update({ goals: { ...goals, ...patch } }).eq("id", ws.id);
  }

  try {
    switch (action.kind) {
      case "set_notify_email":
        await setGoal({ notifyEmail: action.email });
        return { ok: true, note: `reports will go to ${action.email}` };
      case "set_notify_whatsapp":
        await setGoal({ notifyWhatsApp: action.phone });
        return { ok: true, note: `alerts/reports will reach you at ${action.phone} on WhatsApp` };
      case "link_rani_store": {
        const slug = slugify(action.slug);
        await setGoal({ raniStore: slug });
        return { ok: true, note: `linked to your Ask Rani store "${slug}" (your own store data + shared credits now connect)` };
      }
      case "remove_competitor": {
        const { data } = await svc
          .from("competitor_edge")
          .select("id, business:business_id(name)")
          .eq("workspace_id", ws.id);
        const n = action.name.toLowerCase();
        // deno-lint-ignore no-explicit-any
        const hit = (data ?? []).find((e: any) => String(e.business?.name ?? "").toLowerCase().includes(n));
        if (!hit) return { ok: false, note: `I couldn't find a competitor called "${action.name}" in your list.` };
        // deno-lint-ignore no-explicit-any
        await svc.from("competitor_edge").delete().eq("id", (hit as any).id);
        // deno-lint-ignore no-explicit-any
        return { ok: true, note: `stopped watching ${(hit as any).business?.name ?? action.name}` };
      }
    }
  } catch (e) {
    return { ok: false, note: (e as Error).message };
  }
  return { ok: false };
}
