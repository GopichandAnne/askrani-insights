"use client";

import { useMemo, useState } from "react";

// Austin Indian restaurants & grocers, with Instagram handles resolved live from each
// business's own website (Sep 2026). ig="" → site bot-blocked or no IG link; open the
// website/listing to grab it. Every handle is editable — the owner confirms.
type Biz = { id: string; nm: string; vertical: "restaurant" | "grocery"; area: string; web?: string; ig?: string; place?: boolean; fb?: string; note?: string };
const SEED: Biz[] = [
  { id: "r1", nm: "Desi Circle", vertical: "restaurant", area: "Austin", web: "https://desicircleusa.com", ig: "desicircleaustin", place: true },
  { id: "r2", nm: "Foodistaan", vertical: "restaurant", area: "Austin", web: "https://www.foodistaan.us", ig: "foodistaan.us", place: true },
  { id: "r3", nm: "House of Chettinad", vertical: "restaurant", area: "Austin", web: "https://www.houseofchettinad.com", ig: "houseofchettinad_", fb: "783112738227057" },
  { id: "r4", nm: "Bawarchi Indian Cuisine & Bar", vertical: "restaurant", area: "Leander", web: "https://www.bawarchibiryanis.us", ig: "bawarchibiryanis_usa", place: true },
  { id: "r5", nm: "Chowrastha", vertical: "restaurant", area: "Austin", web: "http://desichowrastha.com", ig: "desichowrastha", place: true },
  { id: "r6", nm: "Hashtag India", vertical: "restaurant", area: "Austin", web: "https://www.hashtagindia.com", ig: "hashtagindia_", place: true },
  { id: "r7", nm: "Naga's Indian Cuisine", vertical: "restaurant", area: "Cedar Park", web: "https://nagasaustin.com", ig: "nagasaustin", place: true },
  { id: "r8", nm: "Salt N Pepper Gourmet Indian Fare", vertical: "restaurant", area: "Cedar Park", web: "https://saltnpepperusa.com", ig: "saltnpepper_cedarpark", place: true, fb: "2180784888652577" },
  { id: "r9", nm: "Tandoor Restaurant & Catering", vertical: "restaurant", area: "Austin", web: "https://www.tandoortx.com", ig: "" },
  { id: "r10", nm: "Sangam Chettinad Indian Cuisine", vertical: "restaurant", area: "Austin", web: "https://www.sangamchettinad.com", ig: "austinsangam", place: true },
  { id: "g1", nm: "Man Pasand Supermarket", vertical: "grocery", area: "Austin", web: "https://www.manpasandsupermarket.com", ig: "manpasandaustin", place: true },
  { id: "g2", nm: "Desi Brothers Farmers Market", vertical: "grocery", area: "Austin", web: "http://www.desibrothers.com", ig: "desibrothersaustin", place: true, fb: "995560993644381", note: "Corrected to the Austin account (was the DFW handle) — confirm via Open ↗." },
  { id: "g3", nm: "India Bazaar Austin", vertical: "grocery", area: "Cedar Park", web: "https://www.indiabazaar.us", ig: "indiabazaaraustin", place: true, fb: "929976970198035" },
  { id: "g4", nm: "Big Bazaar Fresh Market", vertical: "grocery", area: "Austin", web: "https://www.big-bazaar.co", ig: "", place: true },
  { id: "g5", nm: "Gandhi Bazar", vertical: "grocery", area: "Austin", web: "http://www.gandhi-bazar.com", ig: "" },
  { id: "g6", nm: "International Foods (Halal)", vertical: "grocery", area: "Austin", web: "https://ifatx.com", ig: "internationalfoodsaustin", place: true },
  { id: "g7", nm: "Dana Bazaar Indian Supermarket", vertical: "grocery", area: "Austin", web: "https://danabazaarsupermarket.com", ig: "danabazaarsupermarket" },
  { id: "g8", nm: "Iqbal Foods", vertical: "grocery", area: "Austin", ig: "", place: true },
  { id: "g9", nm: "H Mart (Lakeline)", vertical: "grocery", area: "Austin", web: "https://www.hmart.com", ig: "hmartofficial", place: true, fb: "105951276119949", note: "Korean grocer, not Indian — a competitor. Confirm you want it in the set." },
  { id: "g10", nm: "Patel Brothers", vertical: "grocery", area: "Cedar Park", web: "https://www.patelbros.com", ig: "patelbrothers", place: true, note: "Open in Cedar Park (2026). No dedicated local Instagram — only national @patelbrothers — so its Google listing / flyers are the better local signal to watch." },
];

const mapsUrl = (b: Biz) => `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(`${b.nm} ${b.area} TX`)}`;

export function MonitorQueueClient() {
  const [handles, setHandles] = useState<Record<string, string>>(() => Object.fromEntries(SEED.map((b) => [b.id, b.ig ?? ""])));
  const [sel, setSel] = useState<Set<string>>(() => new Set());
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [done, setDone] = useState<{ created: { workspaceId: string; vertical: string; count: number }[]; total: number } | null>(null);

  const groups = useMemo(() => ({
    restaurant: SEED.filter((b) => b.vertical === "restaurant"),
    grocery: SEED.filter((b) => b.vertical === "grocery"),
  }), []);
  const hOf = (id: string) => (handles[id] ?? "").trim();
  const toggle = (id: string) => setSel((s) => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n; });
  const missing = [...sel].filter((id) => !hOf(id)).length;

  async function begin() {
    if (!sel.size) return;
    if (missing) { setErr(`${missing} selected still need a handle — open their site to find it, or untick.`); return; }
    setBusy(true); setErr(null);
    const businesses = [...sel].map((id) => { const b = SEED.find((x) => x.id === id)!; return { name: b.nm, vertical: b.vertical, website: b.web, handle: hOf(id) }; });
    try {
      const r = await fetch("/api/monitor/selected", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ label: "Austin, TX", businesses }) });
      const d = await r.json();
      if (r.status === 402 || d.needsCredits) { setErr(`Not enough credits — starting this needs ${d.quote}. Top up in Billing.`); setBusy(false); return; }
      if (!r.ok || !d.created?.length) { setErr(d.error ?? "Couldn't start monitoring."); setBusy(false); return; }
      setDone({ created: d.created, total: d.total });
    } catch (e) { setErr((e as Error).message); setBusy(false); }
  }

  async function openFirst() {
    const wsId = done?.created[0]?.workspaceId;
    if (!wsId) return;
    try { await fetch("/api/workspace/active", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ workspaceId: wsId }) }); } catch { /* ignore */ }
    window.location.href = "/market";
  }

  if (done) {
    return (
      <div className="glass-strong rounded-3xl p-6">
        <div className="text-2xl">✅</div>
        <h2 className="mt-2 font-display text-xl font-bold">Collecting for {done.total} business{done.total === 1 ? "" : "es"}.</h2>
        <p className="mt-1 text-ink-soft">
          Queued {done.created.map((c) => `${c.count} ${c.vertical}`).join(" · ")}. First results land after the initial collection run.
        </p>
        <button onClick={openFirst} className="mt-4 rounded-xl bg-brand px-5 py-2.5 font-medium text-white hover:bg-brand-deep">
          Open the market →
        </button>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {(["restaurant", "grocery"] as const).map((key) => (
        <section key={key} className="space-y-2">
          <div className="flex items-center gap-2">
            <span className={`rounded-md px-2 py-0.5 text-[11px] font-medium uppercase tracking-wide ${key === "restaurant" ? "bg-violet-100 text-violet-700 dark:bg-violet-950/50 dark:text-violet-300" : "bg-amber-100 text-amber-700 dark:bg-amber-950/50 dark:text-amber-300"}`}>
              {key === "restaurant" ? "Restaurant" : "Grocery"}
            </span>
            <h2 className="font-display text-lg font-bold">{key === "restaurant" ? "Indian restaurants" : "Indian & South-Asian grocery"}</h2>
            <span className="ml-auto text-xs tabular-nums text-ink-faint">{groups[key].filter((b) => sel.has(b.id)).length}/{groups[key].length} selected</span>
          </div>
          <ul className="space-y-2">
            {groups[key].map((b) => {
              const h = hOf(b.id);
              const on = sel.has(b.id);
              const state = b.id === "g9" ? { c: "bg-rose-100 text-rose-700 dark:bg-rose-950/50 dark:text-rose-300", t: "review" }
                : h ? { c: "bg-emerald-100 text-emerald-700 dark:bg-emerald-950/50 dark:text-emerald-300", t: "discovered" }
                : { c: "bg-amber-100 text-amber-700 dark:bg-amber-950/50 dark:text-amber-300", t: "open to find" };
              return (
                <li key={b.id} className={`rounded-2xl border p-4 transition-colors ${on ? "border-brand bg-brand/5" : "border-line/60 bg-surface"}`}>
                  <div className="flex items-start gap-3">
                    <input type="checkbox" checked={on} onChange={() => toggle(b.id)} className="mt-1 h-5 w-5 flex-none accent-brand" aria-label={`Monitor ${b.nm}`} />
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="font-semibold">{b.nm}</span>
                        <span className="text-xs text-ink-faint">{b.area}</span>
                        <span className={`rounded px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide ${state.c}`}>{state.t}</span>
                      </div>
                      <div className="mt-2 flex flex-wrap items-center gap-2">
                        <span className="font-mono text-ink-faint">@</span>
                        <input
                          value={h}
                          onChange={(e) => setHandles((s) => ({ ...s, [b.id]: e.target.value.replace(/^@+/, "").trim() }))}
                          placeholder="find & paste their handle"
                          spellCheck={false} autoCapitalize="off"
                          className="max-w-[300px] flex-1 rounded-lg border border-line/60 bg-surface-sunken px-3 py-1.5 font-mono text-sm outline-none focus:border-brand"
                        />
                        <a
                          href={h ? `https://instagram.com/${h}` : undefined}
                          target="_blank" rel="noopener noreferrer"
                          aria-disabled={!h}
                          className={`rounded-lg px-3 py-1.5 text-sm font-medium ${h ? "bg-brand text-white hover:bg-brand-deep" : "pointer-events-none bg-surface-sunken text-ink-faint"}`}
                        >Open ↗</a>
                      </div>
                      <div className="mt-2 flex flex-wrap gap-4 text-xs">
                        {b.web && <a href={b.web} target="_blank" rel="noopener noreferrer" className="text-brand hover:underline">◱ Website</a>}
                        {b.place && <a href={mapsUrl(b)} target="_blank" rel="noopener noreferrer" className="text-brand hover:underline">◎ Google listing</a>}
                        {b.fb && <a href={`https://facebook.com/${b.fb}`} target="_blank" rel="noopener noreferrer" className="text-brand hover:underline">f Facebook</a>}
                      </div>
                      {b.note && <p className="mt-2 text-xs text-rose-600 dark:text-rose-400">⚠ {b.note}</p>}
                    </div>
                  </div>
                </li>
              );
            })}
          </ul>
        </section>
      ))}

      {err && <p className="rounded-xl bg-rose-50 px-4 py-3 text-sm text-rose-700 dark:bg-rose-950/40 dark:text-rose-300">{err}</p>}

      <div className="sticky bottom-4 z-10 flex flex-wrap items-center gap-4 rounded-2xl border border-line/60 bg-surface/90 p-4 shadow-lg backdrop-blur">
        <div className="text-sm">
          <span className="font-display text-xl font-bold tabular-nums">{sel.size}</span> selected
          <div className="text-xs text-ink-faint">{sel.size === 0 ? "Confirm handles, then select" : missing ? `${missing} still need a handle` : "All selected have a handle — ready"}</div>
        </div>
        <button onClick={begin} disabled={!sel.size || busy} className="ml-auto rounded-xl bg-brand px-5 py-3 font-medium text-white hover:bg-brand-deep disabled:opacity-40">
          {busy ? "Starting…" : `Begin collecting${sel.size ? ` (${sel.size})` : ""}`}
        </button>
        <p className="w-full font-mono text-xs text-ink-faint">Starts weekly monitoring and spends collection credits only for the businesses you approved.</p>
      </div>
    </div>
  );
}
