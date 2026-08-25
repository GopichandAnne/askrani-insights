import { AiFindabilityButton } from "@/components/AiFindabilityButton";
import type { AiFindabilityReport } from "@/lib/aifindability";

/** The AI-search read, shown on the Findability page right beside Google search —
 *  they're two halves of "can customers find me?" and share the same keyword set. */
export function AiFindabilityCard({ ai }: { ai: AiFindabilityReport | null }) {
  const empty = !ai || ai.empty;
  return (
    <div className="card">
      <div className="mb-1 flex flex-wrap items-start justify-between gap-2">
        <div>
          <h2 className="font-semibold">AI search</h2>
          <p className="text-xs text-ink-faint">When customers ask an AI (ChatGPT, Perplexity) where to go, does it recommend you?</p>
        </div>
        <AiFindabilityButton />
      </div>

      {empty ? (
        <p className="mt-2 text-sm text-ink-soft">
          {ai?.note
            ? <>Not showing yet — <span className="text-ink">{ai.note}</span>.</>
            : "Not checked yet — hit “✦ Check AI search” to see whether AI assistants recommend you for the searches you track."}
        </p>
      ) : (
        <>
          <div className="mt-3 flex flex-wrap items-end gap-x-10 gap-y-3">
            <div>
              <p className="text-xs uppercase tracking-wide text-ink-faint">Your AI visibility</p>
              <p className="font-display text-3xl font-extrabold leading-none">{ai!.score}<span className="text-base font-semibold text-ink-faint">/100</span></p>
            </div>
            <div>
              <p className="text-xs uppercase tracking-wide text-ink-faint">Checked</p>
              <p className="text-sm text-ink">{ai!.queries} questions · {ai!.engines.join(", ") || "—"}</p>
            </div>
          </div>

          {ai!.competitorsRecommended?.length > 0 && (
            <div className="mt-3">
              <p className="mb-1 text-xs font-semibold text-ink-soft">Who the AIs recommend most</p>
              <ul className="space-y-1">
                {ai!.competitorsRecommended.map((c) => (
                  <li key={c.name} className="flex items-center justify-between rounded-xl bg-white/50 px-3 py-1.5 text-sm">
                    <span className="min-w-0 truncate">{c.name}</span>
                    <span className="shrink-0 text-xs text-ink-faint">{c.mentions}× recommended</span>
                  </li>
                ))}
              </ul>
            </div>
          )}

          <p className="mt-2 text-[11px] text-ink-faint">
            Last checked {new Date(ai!.at).toLocaleDateString()} · a mention-rate across {ai!.engines.join(" + ") || "AI engines"} for the searches you track, refreshed weekly.
          </p>
        </>
      )}
    </div>
  );
}
