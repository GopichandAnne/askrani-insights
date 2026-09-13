"use client";

import { useMemo, useState } from "react";

// Austin/Cedar Park/Round Rock Indian restaurants & grocers with social handles
// resolved from their own sites + web search (Sep 2026). Every handle is a
// SUGGESTION to validate — open the profile to confirm it's the right account.
type Chan = "instagram" | "facebook" | "tiktok" | "youtube";
type Vert = "restaurant" | "grocery";
// facets: a business can be BOTH (Foodistaan/Desi Circle sell groceries; many desi
// grocers have a deli/hot counter). It's then watched & compared in each. Defaults
// to [vertical]; pre-marked for the obvious hybrids, human-adjustable in the UI.
type Biz = { id: string; nm: string; vertical: Vert; area: string; web?: string; place?: boolean; note?: string; handles: Partial<Record<Chan, string>>; facets?: Vert[] };

const CHAN: { key: Chan; label: string; icon: string; base: string }[] = [
  { key: "instagram", label: "Instagram", icon: "📸", base: "https://instagram.com/" },
  { key: "facebook", label: "Facebook", icon: "👍", base: "https://facebook.com/" },
  { key: "tiktok", label: "TikTok", icon: "🎵", base: "https://tiktok.com/@" },
  { key: "youtube", label: "YouTube", icon: "▶️", base: "https://youtube.com/@" },
];

const SEED: Biz[] = [
  { id: "r1", nm: "Desi Circle", vertical: "restaurant", area: "Austin", web: "https://desicircleusa.com", place: true, handles: { instagram: "desicircleaustin" }, facets: ["restaurant", "grocery"] },
  { id: "r2", nm: "Foodistaan", vertical: "restaurant", area: "Cedar Park", web: "https://www.foodistaan.us", place: true, handles: { instagram: "foodistaancp" }, note: "Location account — @foodistaancp (Cedar Park), not the national @foodistaan.us.", facets: ["restaurant", "grocery"] },
  { id: "r3", nm: "House of Chettinad", vertical: "restaurant", area: "Austin", web: "https://www.houseofchettinad.com", place: true, handles: { instagram: "houseofchettinad_", tiktok: "houseofchettinad_" } },
  { id: "r4", nm: "Bawarchi Indian Cuisine & Bar", vertical: "restaurant", area: "Leander", web: "https://www.bawarchibiryanis.us", place: true, handles: { instagram: "bawarchi_indiancuisine_bar_tx" }, note: "Location account — @bawarchi_indiancuisine_bar_tx (Leander), not the national @bawarchibiryanis_usa." },
  { id: "r5", nm: "Chowrastha", vertical: "restaurant", area: "Austin", web: "http://desichowrastha.com", place: true, handles: { instagram: "desichowrastha", facebook: "chowrastha-104748712131254" } },
  { id: "r6", nm: "Hashtag India", vertical: "restaurant", area: "Leander", web: "https://www.hashtagindia.com", place: true, handles: { instagram: "hashtagindia.leander" }, note: "Location account — @hashtagindia.leander, not the national @hashtagindia_ (all 15 stores)." },
  { id: "r7", nm: "Naga's Indian Cuisine", vertical: "restaurant", area: "Cedar Park", web: "https://nagasaustin.com", place: true, handles: { instagram: "nagasaustin" } },
  { id: "r8", nm: "Salt N Pepper Gourmet Indian Fare", vertical: "restaurant", area: "Cedar Park", web: "https://saltnpepperusa.com", place: true, handles: { instagram: "saltnpepper_cedarpark" } },
  { id: "r9", nm: "Tandoor Restaurant & Catering", vertical: "restaurant", area: "Austin", web: "https://www.tandoortx.com", place: true, handles: {} },
  { id: "r10", nm: "Sangam Chettinad Indian Cuisine", vertical: "restaurant", area: "Austin", web: "https://www.sangamchettinad.com", place: true, handles: { instagram: "austinsangam", facebook: "austinsangam" } },
  { id: "r11", nm: "Teji's", vertical: "restaurant", area: "Austin", place: true, handles: { instagram: "tejisindian" } },
  { id: "r12", nm: "Tulsi Indian Cuisine", vertical: "restaurant", area: "Austin", place: true, handles: { instagram: "tulsifineindian_austin" } },
  { id: "r13", nm: "Kuppanna Indian Restaurant", vertical: "restaurant", area: "Austin", place: true, handles: { instagram: "kuppannaaustin" } },
  { id: "r14", nm: "Aroma — Indian Food Park", vertical: "restaurant", area: "Round Rock", place: true, handles: { instagram: "aromaaustin" } },
  { id: "r15", nm: "Bayleaf Indian Restaurant & Bar", vertical: "restaurant", area: "Round Rock", place: true, handles: { instagram: "bayleaf_indian_restaurant_bar" } },
  { id: "r16", nm: "Asiana Indian Cuisine", vertical: "restaurant", area: "Austin", place: true, handles: { instagram: "asiana_indian_cuisine" } },
  { id: "g1", nm: "Man Pasand Supermarket", vertical: "grocery", area: "Austin", web: "https://www.manpasandsupermarket.com", place: true, handles: { instagram: "manpasandaustin" }, facets: ["grocery", "restaurant"] },
  { id: "g2", nm: "Desi Brothers Farmers Market", vertical: "grocery", area: "Austin", web: "http://www.desibrothers.com", place: true, handles: { instagram: "desibrothersaustin" }, note: "Location account — @desibrothersaustin (the DFW Facebook was dropped as wrong-metro).", facets: ["grocery", "restaurant"] },
  { id: "g3", nm: "India Bazaar Austin", vertical: "grocery", area: "Cedar Park", web: "https://www.indiabazaar.us", place: true, handles: { instagram: "indiabazaaraustin" }, facets: ["grocery", "restaurant"] },
  { id: "g4", nm: "Big Bazaar Fresh Market", vertical: "grocery", area: "Cedar Park", web: "https://www.big-bazaar.co", place: true, handles: { instagram: "bigbazaar789" }, note: "Two similar Big Bazaar IG accounts — @bigbazaar789 is the Cedar Park one. Confirm." },
  { id: "g5", nm: "Gandhi Bazar", vertical: "grocery", area: "Austin", web: "http://www.gandhi-bazar.com", place: true, handles: { facebook: "gandhibazarstore" }, note: "Only a Facebook page found — add their Instagram if they have one." },
  { id: "g6", nm: "International Foods (Halal)", vertical: "grocery", area: "Austin", web: "https://ifatx.com", place: true, handles: { instagram: "internationalfoodsaustin" } },
  { id: "g7", nm: "Dana Bazaar Indian Supermarket", vertical: "grocery", area: "Austin", web: "https://danabazaarsupermarket.com", place: true, handles: { instagram: "danabazaarsupermarket", facebook: "danabazaaraustin" } },
  { id: "g8", nm: "Iqbal Foods", vertical: "grocery", area: "Austin", place: true, handles: {} },
  { id: "g9", nm: "H Mart (Lakeline)", vertical: "grocery", area: "Austin", web: "https://www.hmart.com", place: true, handles: { instagram: "hmartofficial" }, note: "Korean grocer, not Indian — a competitor. Confirm you want it in the set." },
  { id: "g10", nm: "Patel Brothers", vertical: "grocery", area: "Cedar Park", web: "https://www.patelbros.com", place: true, handles: { instagram: "patelbrotherscedarpark" }, note: "Open in Cedar Park (2026). Confirm @patelbrotherscedarpark via Open ↗." },
  { id: "g11", nm: "Khana Khazana ATX", vertical: "grocery", area: "Cedar Park", place: true, handles: { instagram: "khana_khazana_atx" } },
  { id: "g12", nm: "MTM Indian Grocery & Fish", vertical: "grocery", area: "Austin", place: true, handles: { instagram: "mtmindianfoodsinc" } },
];

const mapsUrl = (b: Biz) => `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(`${b.nm} ${b.area} TX`)}`;

export function MonitorQueueClient() {
  const [handles, setHandles] = useState<Record<string, Partial<Record<Chan, string>>>>(() => Object.fromEntries(SEED.map((b) => [b.id, { ...b.handles }])));
  const [facets, setFacets] = useState<Record<string, Vert[]>>(() => Object.fromEntries(SEED.map((b) => [b.id, b.facets ?? [b.vertical]])));
  const [sel, setSel] = useState<Set<string>>(() => new Set());
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [resolving, setResolving] = useState(false);
  const [resolveMsg, setResolveMsg] = useState<string | null>(null);
  const [done, setDone] = useState<{ created: { workspaceId: string; vertical: string; count: number }[]; total: number } | null>(null);

  const groups = useMemo(() => ({ restaurant: SEED.filter((b) => b.vertical === "restaurant"), grocery: SEED.filter((b) => b.vertical === "grocery") }), []);
  const chanCount = (id: string) => CHAN.filter((c) => (handles[id]?.[c.key] ?? "").trim()).length;
  const toggle = (id: string) => setSel((s) => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n; });
  const other = (b: Biz): Vert => (b.vertical === "restaurant" ? "grocery" : "restaurant");
  const isHybrid = (b: Biz) => (facets[b.id] ?? [b.vertical]).includes(other(b));
  const toggleFacet = (b: Biz) => setFacets((s) => {
    const cur = s[b.id] ?? [b.vertical]; const o = other(b);
    return { ...s, [b.id]: cur.includes(o) ? cur.filter((f) => f !== o) : [...cur, o] };
  });
  const setH = (id: string, key: Chan, v: string) => setHandles((s) => ({ ...s, [id]: { ...s[id], [key]: v.replace(/^@+/, "").trim() } }));

  // Intelligent, location-aware re-resolution: run the app's resolver over the
  // selected businesses so a multi-location brand resolves to its LOCAL account
  // (e.g. @foodistaancp) instead of the national one. Chunked (the resolver is slow).
  async function resolveSelected() {
    const ids = [...sel];
    if (!ids.length) { setResolveMsg("Select the businesses to re-resolve first."); return; }
    setResolving(true); setResolveMsg(null); setErr(null);
    let updated = 0;
    try {
      for (let i = 0; i < ids.length; i += 10) {
        const chunk = ids.slice(i, i + 10).map((id) => { const b = SEED.find((x) => x.id === id)!; return { id, name: b.nm, area: b.area, website: b.web }; });
        const r = await fetch("/api/monitor/resolve", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ businesses: chunk }) });
        const d = await r.json();
        if (!r.ok) { setErr(d.error ?? "Re-resolve failed."); break; }
        setHandles((s) => {
          const next = { ...s };
          for (const res of d.results ?? []) {
            const h = res.handles ?? {};
            if (Object.keys(h).length) { next[res.id] = { ...next[res.id], ...h }; updated++; }
          }
          return next;
        });
      }
      setResolveMsg(`Re-resolved handles for ${updated} of ${ids.length} selected — review the ↗ links, then collect.`);
    } catch (e) { setErr((e as Error).message); }
    finally { setResolving(false); }
  }

  async function begin() {
    if (!sel.size) return;
    setBusy(true); setErr(null);
    const businesses = [...sel].map((id) => { const b = SEED.find((x) => x.id === id)!; return { name: b.nm, vertical: b.vertical, website: b.web, handles: handles[id] ?? {}, facets: facets[id] ?? [b.vertical] }; });
    try {
      const r = await fetch("/api/monitor/selected", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ label: "Austin, TX", businesses }) });
      const d = await r.json();
      if (r.status === 402 || d.needsCredits) { setErr(`Not enough credits — starting this needs ${d.quote}. Top up in Billing.`); setBusy(false); return; }
      if (!r.ok || !d.created?.length) { setErr(d.error ?? "Couldn't start monitoring."); setBusy(false); return; }
      setDone({ created: d.created, total: d.total });
    } catch (e) { setErr((e as Error).message); setBusy(false); }
  }
  async function openFirst() {
    const wsId = done?.created[0]?.workspaceId; if (!wsId) return;
    try { await fetch("/api/workspace/active", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ workspaceId: wsId }) }); } catch { /* ignore */ }
    window.location.href = "/market";
  }

  if (done) {
    return (
      <div className="glass-strong rounded-3xl p-6">
        <div className="text-2xl">✅</div>
        <h2 className="mt-2 font-display text-xl font-bold">Collecting for {done.total} business{done.total === 1 ? "" : "es"} across every channel.</h2>
        <p className="mt-1 text-ink-soft">Queued {done.created.map((c) => `${c.count} ${c.vertical}`).join(" · ")}. Website, Google &amp; Yelp start immediately; social posts follow as each handle is targeted.</p>
        <button onClick={openFirst} className="mt-4 rounded-xl bg-brand px-5 py-2.5 font-medium text-white hover:bg-brand-deep">Open the market →</button>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="rounded-xl border border-line/60 bg-surface-sunken px-4 py-3 text-sm text-ink-soft">
        <p>Each business is watched across <b>Instagram, Facebook, TikTok &amp; YouTube</b> (confirm the handles below) plus <b>Website, Google &amp; Yelp</b> (automatic — matched by name &amp; location, no handle needed).</p>
        <div className="mt-2.5 flex flex-wrap items-center gap-3">
          <button onClick={resolveSelected} disabled={resolving} className="rounded-lg border border-brand/40 bg-brand/10 px-3 py-1.5 text-[13px] font-medium text-brand hover:bg-brand/20 disabled:opacity-50">
            {resolving ? "Re-resolving…" : "🔍 Re-resolve selected (location-aware)"}
          </button>
          <span className="text-xs text-ink-faint">Picks the <b>local</b> account for a multi-location brand (e.g. @foodistaancp, not the national handle).</span>
        </div>
        {resolveMsg && <p className="mt-2 text-xs text-brand">{resolveMsg}</p>}
      </div>

      {(["restaurant", "grocery"] as const).map((key) => (
        <section key={key} className="space-y-2">
          <div className="flex items-center gap-2">
            <span className={`rounded-md px-2 py-0.5 text-[11px] font-medium uppercase tracking-wide ${key === "restaurant" ? "bg-violet-100 text-violet-700 dark:bg-violet-950/50 dark:text-violet-300" : "bg-amber-100 text-amber-700 dark:bg-amber-950/50 dark:text-amber-300"}`}>{key === "restaurant" ? "Restaurant" : "Grocery"}</span>
            <h2 className="font-display text-lg font-bold">{key === "restaurant" ? "Indian restaurants" : "Indian & South-Asian grocery"}</h2>
            <span className="ml-auto text-xs tabular-nums text-ink-faint">{groups[key].filter((b) => sel.has(b.id)).length}/{groups[key].length} selected</span>
          </div>
          <ul className="space-y-2">
            {groups[key].map((b) => {
              const on = sel.has(b.id);
              const n = chanCount(b.id);
              return (
                <li key={b.id} className={`rounded-2xl border p-4 transition-colors ${on ? "border-brand bg-brand/5" : "border-line/60 bg-surface"}`}>
                  <div className="flex items-start gap-3">
                    <input type="checkbox" checked={on} onChange={() => toggle(b.id)} className="mt-1 h-5 w-5 flex-none accent-brand" aria-label={`Monitor ${b.nm}`} />
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="font-semibold">{b.nm}</span>
                        <span className="text-xs text-ink-faint">{b.area}</span>
                        <span className={`rounded px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide ${n ? "bg-emerald-100 text-emerald-700 dark:bg-emerald-950/50 dark:text-emerald-300" : "bg-amber-100 text-amber-700 dark:bg-amber-950/50 dark:text-amber-300"}`}>{n ? `${n} channel${n === 1 ? "" : "s"}` : "web/Google only"}</span>
                        <button type="button" onClick={() => toggleFacet(b)} title="Some restaurants also sell groceries (and some grocers have a deli). A hybrid is watched & compared in both."
                          className={`rounded-full px-2 py-0.5 text-[10px] font-medium ${isHybrid(b) ? "bg-brand/15 text-brand" : "border border-line/60 text-ink-faint hover:border-brand hover:text-brand"}`}>
                          {isHybrid(b) ? "🍽️ + 🛒 both" : `+ also ${other(b)}`}
                        </button>
                      </div>
                      <div className="mt-2 grid gap-1.5 sm:grid-cols-2">
                        {CHAN.map((c) => {
                          const v = (handles[b.id]?.[c.key] ?? "").trim();
                          return (
                            <div key={c.key} className="flex items-center gap-1.5">
                              <span className="w-7 text-center text-sm" title={c.label} aria-hidden>{c.icon}</span>
                              <input value={v} onChange={(e) => setH(b.id, c.key, e.target.value)} placeholder={`${c.label} handle`} spellCheck={false} autoCapitalize="off"
                                className="min-w-0 flex-1 rounded-lg border border-line/60 bg-surface-sunken px-2.5 py-1 font-mono text-[13px] outline-none focus:border-brand" />
                              <a href={v ? `${c.base}${v}` : undefined} target="_blank" rel="noopener noreferrer" aria-disabled={!v}
                                className={`rounded-md px-2 py-1 text-xs font-medium ${v ? "bg-brand/10 text-brand hover:bg-brand/20" : "pointer-events-none text-ink-faint"}`}>↗</a>
                            </div>
                          );
                        })}
                      </div>
                      <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-ink-faint">
                        <span>Auto: {b.web ? <a href={b.web} target="_blank" rel="noopener noreferrer" className="text-brand hover:underline">Website</a> : "Website"} · <a href={mapsUrl(b)} target="_blank" rel="noopener noreferrer" className="text-brand hover:underline">Google</a> · Yelp</span>
                      </div>
                      {b.note && <p className="mt-1.5 text-xs text-rose-600 dark:text-rose-400">⚠ {b.note}</p>}
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
          <div className="text-xs text-ink-faint">{sel.size === 0 ? "Confirm handles, then select" : "Website, Google & Yelp collect even where a social handle is blank"}</div>
        </div>
        <button onClick={begin} disabled={!sel.size || busy} className="ml-auto rounded-xl bg-brand px-5 py-3 font-medium text-white hover:bg-brand-deep disabled:opacity-40">
          {busy ? "Starting…" : `Begin collecting${sel.size ? ` (${sel.size})` : ""}`}
        </button>
        <p className="w-full font-mono text-xs text-ink-faint">Starts weekly multi-channel monitoring and spends collection credits only for the businesses you approved.</p>
      </div>
    </div>
  );
}
