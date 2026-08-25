"use client";

import { useEffect, useState } from "react";
import { keywordExamples } from "@/lib/vertical-vocab";

interface Kw { id: string; term: string; intent: string; value_weight: number; active: boolean }
interface Sug { term: string; intent: string; value_weight: number }

const INTENT_DOT: Record<string, string> = { everyday: "bg-brand", urgent: "bg-coral", high_value: "bg-amber-500" };

/** Owner control over the exact Google searches Findability tracks: see the
 *  tracked terms, add your own (dish-level / "near me"), and pull Rani's
 *  menu-aware suggestions to add with one tap. */
export function FindabilityKeywords({ workspaceId, vertical }: { workspaceId: string; vertical?: string }) {
  const [kws, setKws] = useState<Kw[]>([]);
  const [loading, setLoading] = useState(true);
  const [val, setVal] = useState("");
  const [busy, setBusy] = useState(false);
  const [sugs, setSugs] = useState<Sug[]>([]);
  const [suggesting, setSuggesting] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  async function load() {
    try {
      const r = await fetch(`/api/findability/keywords?workspaceId=${workspaceId}`, { cache: "no-store" });
      const d = await r.json();
      setKws(d.keywords ?? []);
    } catch { /* ignore */ } finally { setLoading(false); }
  }
  useEffect(() => { load(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, []);

  async function add(terms: { term: string; intent?: string; value_weight?: number }[]) {
    if (!terms.length || busy) return;
    setBusy(true); setMsg(null);
    try {
      const r = await fetch("/api/findability/keywords", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ workspaceId, action: "add", terms }) });
      const d = await r.json();
      if (d.keywords) setKws(d.keywords);
      setSugs((s) => s.filter((x) => !terms.some((t) => t.term.toLowerCase() === x.term.toLowerCase())));
      setMsg("Added — new terms get ranked on your next scan.");
    } finally { setBusy(false); }
  }

  async function remove(id: string) {
    setKws((k) => k.filter((x) => x.id !== id));
    await fetch("/api/findability/keywords", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ workspaceId, action: "remove", id }) }).catch(() => {});
  }

  async function suggest() {
    setSuggesting(true); setMsg(null);
    try {
      const r = await fetch("/api/findability/keywords", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ workspaceId, action: "suggest" }) });
      const d = await r.json();
      setSugs(d.suggestions ?? []);
      if (!(d.suggestions ?? []).length) setMsg("No new suggestions right now — you're tracking the main ones.");
    } catch { setMsg("Couldn’t get suggestions right now."); } finally { setSuggesting(false); }
  }

  function addCustom() {
    const t = val.trim().toLowerCase();
    if (t.length < 4) return;
    setVal("");
    add([{ term: t }]);
  }

  return (
    <div className="card">
      <div className="mb-1 flex flex-wrap items-center justify-between gap-2">
        <h2 className="font-semibold">Search terms we track</h2>
        <button onClick={suggest} disabled={suggesting} className="text-xs font-medium text-brand underline disabled:opacity-60">
          {suggesting ? "Thinking…" : "✦ Ask Rani to suggest more"}
        </button>
      </div>
      <p className="mb-3 text-xs text-ink-faint">
        These are the exact Google searches we check your rank for. Add the ones your customers really type — a specific offering, a
        &ldquo;near me&rdquo; search, or a nearby town (e.g. <i>{keywordExamples(vertical)}</i>).
      </p>

      {loading ? (
        <p className="text-sm text-ink-faint">Loading…</p>
      ) : (
        <div className="flex flex-wrap gap-1.5">
          {kws.map((k) => (
            <span key={k.id} className="chip inline-flex items-center gap-1.5 bg-surface-sunken">
              <span className={`h-1.5 w-1.5 rounded-full ${INTENT_DOT[k.intent] ?? "bg-brand"}`} aria-hidden />
              {k.term}
              <button onClick={() => remove(k.id)} className="text-ink-faint hover:text-trust-low" title="Stop tracking">✕</button>
            </span>
          ))}
          {!kws.length && <span className="text-sm text-ink-faint">No terms yet — add some below or ask Rani to suggest.</span>}
        </div>
      )}

      {/* add your own */}
      <div className="mt-3 flex gap-2">
        <input
          value={val}
          onChange={(e) => setVal(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && addCustom()}
          placeholder="Add a search term customers use…"
          className="field flex-1 py-2 text-sm"
        />
        <button onClick={addCustom} disabled={busy || val.trim().length < 4} className="btn btn-secondary px-4 py-2 text-sm disabled:opacity-60">Add</button>
      </div>

      {/* Rani suggestions */}
      {sugs.length > 0 && (
        <div className="mt-3 rounded-2xl bg-brand-soft/40 p-3">
          <div className="mb-2 flex items-center justify-between">
            <span className="text-xs font-semibold text-brand-deep">✦ Rani suggests — tap to add</span>
            <button onClick={() => add(sugs.map((s) => ({ term: s.term, intent: s.intent, value_weight: s.value_weight })))} disabled={busy} className="text-xs font-medium text-brand underline disabled:opacity-60">Add all</button>
          </div>
          <div className="flex flex-wrap gap-1.5">
            {sugs.map((s) => (
              <button key={s.term} onClick={() => add([{ term: s.term, intent: s.intent, value_weight: s.value_weight }])} disabled={busy}
                className="chip inline-flex items-center gap-1 bg-white/70 hover:bg-white disabled:opacity-60">
                <span className={`h-1.5 w-1.5 rounded-full ${INTENT_DOT[s.intent] ?? "bg-brand"}`} aria-hidden />
                {s.term} <span className="text-brand">+</span>
              </button>
            ))}
          </div>
        </div>
      )}

      {msg && <p className="mt-2 text-xs text-brand-deep">{msg}</p>}
      <p className="mt-2 text-[11px] text-ink-faint">Newly added terms are ranked on your next scan — use <b>Track my findability now</b> above to include them right away.</p>
    </div>
  );
}
