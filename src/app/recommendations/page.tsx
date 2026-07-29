import { activeWorkspace } from "@/lib/workspace";
import { createClient } from "@/lib/supabase/server";
import { ScreenNotReady } from "@/components/ScreenNotReady";
import { setRecommendationStatus } from "./actions";

export const dynamic = "force-dynamic";

const STATUS_COLOR: Record<string, string> = {
  proposed: "bg-brand-soft text-brand",
  saved: "bg-trust-corroborated/10 text-trust-corroborated",
  approved: "bg-trust-direct/10 text-trust-direct",
  launched: "bg-trust-direct/10 text-trust-direct",
  dismissed: "bg-surface-sunken text-ink-faint",
};

export default async function RecommendationsPage() {
  const state = await activeWorkspace();
  if (state.status !== "ok") return <ScreenNotReady state={state} title="Recommendations" />;

  const supabase = await createClient();
  const { data: recs } = await supabase
    .from("recommendation")
    .select("id,category,title,action,why_now,expected_impact,effort,urgency,priority,status")
    .eq("workspace_id", state.workspace.id)
    .neq("status", "dismissed")
    .order("priority", { ascending: false });

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Recommendations</h1>
        <p className="mt-1 text-sm text-ink-soft">
          Decision queue for {state.workspace.name}. Approve, save or dismiss — dismissals are recorded.
        </p>
      </div>

      {!recs?.length ? (
        <p className="rounded-xl border border-dashed border-line bg-surface p-6 text-sm text-ink-soft">
          No open recommendations. Re-run a market analysis to refresh them.
        </p>
      ) : (
        <div className="space-y-3">
          {recs.map((r) => {
            const impact = r.expected_impact as { metric?: string; range_pct?: [number, number]; confidence?: number } | null;
            return (
              <div key={r.id} className="rounded-xl border border-line bg-surface p-4">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="chip bg-brand-soft text-brand">{r.category}</span>
                  <span className="font-medium">{r.title}</span>
                  <span className={`chip ${STATUS_COLOR[r.status] ?? ""}`}>{r.status}</span>
                  <span className="ml-auto text-xs text-ink-faint">
                    priority {Number(r.priority).toFixed(2)} · {r.effort} effort · {String(r.urgency).replace("_", " ")}
                  </span>
                </div>
                <p className="mt-2 text-sm">{r.action}</p>
                {Array.isArray(r.why_now) && (
                  <ul className="mt-2 list-disc space-y-0.5 pl-5 text-sm text-ink-soft">
                    {(r.why_now as string[]).map((w, j) => (
                      <li key={j}>{w}</li>
                    ))}
                  </ul>
                )}
                {impact?.metric && (
                  <p className="mt-2 text-xs text-ink-faint">
                    Expected {impact.metric}: +{impact.range_pct?.[0]}–{impact.range_pct?.[1]}% (
                    {Math.round((impact.confidence ?? 0) * 100)}% conf)
                  </p>
                )}
                <div className="mt-3 flex flex-wrap gap-2">
                  {(["approved", "saved", "dismissed"] as const).map((s) => (
                    <form key={s} action={setRecommendationStatus}>
                      <input type="hidden" name="id" value={r.id} />
                      <input type="hidden" name="status" value={s} />
                      <button
                        className={`rounded-lg px-3 py-1 text-xs font-medium ${
                          s === "approved"
                            ? "bg-brand text-white"
                            : s === "dismissed"
                              ? "border border-line text-ink-faint"
                              : "border border-line"
                        }`}
                      >
                        {s === "approved" ? "Approve" : s === "saved" ? "Save" : "Dismiss"}
                      </button>
                    </form>
                  ))}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
