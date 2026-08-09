import { activeWorkspace } from "@/lib/workspace";
import { createClient } from "@/lib/supabase/server";
import { PromoteButton } from "@/components/PromoteButton";

/**
 * Shown on every app page when the active workspace is a deep-read (ephemeral)
 * snapshot — makes clear this is a one-time report (not live monitoring), when it
 * expires, and offers the one-tap promotion to Monitor (with the scan cost credited
 * back). This is the wall between the pay-per-scan tier and the subscription.
 */
export async function EphemeralBanner() {
  const state = await activeWorkspace();
  if (state.status !== "ok") return null;
  const supabase = await createClient();
  const { data } = await supabase.from("workspace").select("goals").eq("id", state.workspace.id).maybeSingle();
  const goals = (data?.goals as Record<string, any> | null) ?? {};
  if (!goals.ephemeral) return null;

  const isArea = goals.deepReadScope === "area";
  const scope = isArea ? "market" : "business";
  const expires = goals.ephemeralExpiresAt ? new Date(goals.ephemeralExpiresAt) : null;
  const expiresLabel = expires ? expires.toLocaleDateString(undefined, { month: "short", day: "numeric" }) : null;
  const creditBack = Number(goals.deepReadCharged ?? 0);

  return (
    <div className="mb-4 rounded-2xl border border-brand/30 bg-brand-soft/50 p-3.5 sm:flex sm:items-center sm:justify-between sm:gap-4">
      <div className="min-w-0">
        <div className="flex items-center gap-2 text-sm font-semibold text-brand-deep">
          <span aria-hidden>🔎</span> Deep read · one-time {scope} snapshot
        </div>
        <p className="mt-0.5 text-xs text-ink-soft">
          This is a paid snapshot, not live monitoring — it won&apos;t refresh or send you a weekly digest.
          {expiresLabel ? ` Available until ${expiresLabel}.` : ""} Promote it to keep it live and watched.
        </p>
      </div>
      <div className="mt-3 flex flex-wrap gap-2 sm:mt-0">
        {isArea ? (
          <>
            <PromoteButton creditBack={creditBack} as="area" label="Monitor this whole area →" />
            <PromoteButton creditBack={0} as="business" variant="secondary" label="Just this business →" />
          </>
        ) : (
          <PromoteButton creditBack={creditBack} />
        )}
      </div>
    </div>
  );
}
