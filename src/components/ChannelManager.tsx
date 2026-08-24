"use client";

import { useState } from "react";
import { PLATFORM_META, SOCIAL_PLATFORMS, type BusinessChannels, type ChannelIdentity } from "@/lib/channels-shared";

/** Per-business channel card: shows what social/web sources we monitor, and lets
 *  the owner attach a handle when automatic mapping missed, or re-run detection. */
export function ChannelManager({ business }: { business: BusinessChannels }) {
  const [identities, setIdentities] = useState<ChannelIdentity[]>(business.identities);
  const [adding, setAdding] = useState(false);
  const [platform, setPlatform] = useState<string>("instagram");
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [detecting, setDetecting] = useState(false);
  const [refreshing, setRefreshing] = useState<string | null>(null);

  const socialCount = identities.filter((i) => PLATFORM_META[i.platform]?.social).length;

  async function add() {
    if (!value.trim()) return;
    setBusy(true); setMsg(null);
    try {
      const res = await fetch("/api/channels/add", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ businessId: business.businessId, platform, url: value.trim() }),
      });
      const data = await res.json();
      if (!res.ok) { setMsg(data.error ?? "Couldn't add that"); return; }
      setIdentities((xs) => {
        const without = xs.filter((x) => x.id !== data.identity.id && !(x.platform === data.identity.platform && x.url === data.identity.url));
        return [{ ...data.identity, posts: 0, lastAt: null }, ...without];
      });
      setValue(""); setAdding(false);
      setMsg("Added — we'll start watching it on the next scan.");
    } finally { setBusy(false); }
  }

  async function remove(id: string) {
    setIdentities((xs) => xs.filter((x) => x.id !== id));
    await fetch("/api/channels/remove", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ identityId: id }),
    });
  }

  // Re-scrape ONE channel on demand — e.g. right after updating your Instagram —
  // without waiting for the next full workspace scan.
  async function refresh(it: ChannelIdentity) {
    if (refreshing) return;
    setRefreshing(it.id); setMsg(null);
    try {
      const res = await fetch("/api/channels/refresh", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ businessId: business.businessId, platform: it.platform }),
      });
      const data = await res.json();
      setMsg(data.message ?? (res.ok ? "Refreshed." : data.error ?? "Couldn’t refresh."));
      if (res.ok && data.collected) {
        const n = (data.collected.posts || 0) + (data.collected.offers || 0);
        if (n > 0) setIdentities((xs) => xs.map((x) => (x.id === it.id ? { ...x, posts: n } : x)));
      }
    } catch {
      setMsg("Couldn’t refresh right now — try again in a moment.");
    } finally {
      setRefreshing(null);
    }
  }

  async function detect() {
    setDetecting(true); setMsg(null);
    try {
      const res = await fetch("/api/channels/detect", {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ businessId: business.businessId }),
      });
      const data = await res.json();
      setMsg(data.message ?? null);
      for (const f of data.found ?? []) {
        setIdentities((xs) => xs.some((x) => x.platform === f.platform && x.url === f.url) ? xs
          : [{ id: `tmp-${f.platform}-${f.url}`, platform: f.platform, url: f.url, handle: null, verification_state: "observed", posts: 0, lastAt: null }, ...xs]);
      }
    } finally { setDetecting(false); }
  }

  return (
    <section className="card">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="flex items-center gap-2 font-semibold">
          {business.isTarget && <span className="chip bg-brand-gradient text-white">You</span>}
          {business.name}
        </h2>
        <span className="text-xs text-ink-faint">
          {socialCount ? `${socialCount} social channel${socialCount === 1 ? "" : "s"} watched` : "no social watched yet"}
        </span>
      </div>

      {identities.length === 0 ? (
        <p className="mt-3 rounded-2xl border border-dashed border-line p-3 text-sm text-ink-faint">
          Nothing monitored yet. Attach their Instagram/Facebook below so their posts &amp; offers get collected.
        </p>
      ) : (
        <ul className="mt-3 space-y-1.5">
          {identities.map((it) => {
            const m = PLATFORM_META[it.platform] ?? { label: it.platform, icon: "🔗", social: false, placeholder: "" };
            return (
              <li key={it.id} className="flex items-center gap-2.5 rounded-2xl bg-white/55 p-2.5 text-sm">
                <span className="grid h-8 w-8 shrink-0 place-items-center rounded-xl bg-brand-soft text-base" aria-hidden>{m.icon}</span>
                <span className="min-w-0 flex-1">
                  <span className="flex flex-wrap items-center gap-1.5">
                    <span className="font-medium">{m.label}</span>
                    <VerifyBadge state={it.verification_state} />
                  </span>
                  {it.url && (
                    <a href={it.url} target="_blank" rel="noreferrer" className="block truncate text-xs text-ink-faint hover:text-brand">
                      {it.handle ? (m.social ? `@${it.handle.replace(/^@/, "")}` : it.handle) : it.url}
                    </a>
                  )}
                </span>
                <span className="hidden shrink-0 text-[11px] text-ink-faint sm:block" title={it.platform === "facebook" && it.posts === 0 ? "Facebook (Meta) blocks scraping — most scans return no posts. Instagram/TikTok are the reliable social sources." : undefined}>
                  {it.posts > 0 ? `${it.posts} collected` : it.platform === "facebook" ? "Meta limits scraping" : "awaiting scan"}
                </span>
                {it.url && (
                  <button
                    onClick={() => refresh(it)}
                    disabled={refreshing === it.id}
                    title="Refresh this channel now"
                    className="grid h-6 w-6 shrink-0 place-items-center rounded-full text-ink-faint hover:bg-brand-soft hover:text-brand disabled:opacity-50"
                  >
                    <span className={refreshing === it.id ? "inline-block animate-spin" : ""} aria-hidden>↻</span>
                  </button>
                )}
                <button onClick={() => remove(it.id)} title="Stop monitoring" className="grid h-6 w-6 shrink-0 place-items-center rounded-full text-ink-faint hover:bg-trust-low/10 hover:text-trust-low">✕</button>
              </li>
            );
          })}
        </ul>
      )}

      {msg && <p className="mt-2 text-xs text-brand-deep">{msg}</p>}

      <div className="mt-3 flex flex-wrap items-center gap-2">
        {!adding ? (
          <button onClick={() => setAdding(true)} className="btn btn-secondary px-3 py-1.5 text-sm">+ Attach a channel</button>
        ) : (
          <div className="flex w-full flex-wrap items-center gap-2">
            <select value={platform} onChange={(e) => setPlatform(e.target.value)} className="field w-auto py-1.5 text-sm">
              {SOCIAL_PLATFORMS.map((p) => <option key={p} value={p}>{PLATFORM_META[p].label}</option>)}
              <option value="doordash">DoorDash</option>
              <option value="ubereats">Uber Eats</option>
              <option value="website">Website</option>
            </select>
            <input
              value={value}
              onChange={(e) => setValue(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && add()}
              placeholder={PLATFORM_META[platform]?.placeholder}
              className="field min-w-0 flex-1 py-1.5 text-sm"
            />
            <button onClick={add} disabled={busy} className="btn btn-primary px-4 py-1.5 text-sm disabled:opacity-60">{busy ? "Adding…" : "Add"}</button>
            <button onClick={() => { setAdding(false); setValue(""); }} className="text-xs text-ink-faint">cancel</button>
          </div>
        )}
        <button onClick={detect} disabled={detecting} className="text-xs font-medium text-brand underline disabled:opacity-60">
          {detecting ? "Searching…" : "✦ Auto-find their handles"}
        </button>
      </div>
    </section>
  );
}

function VerifyBadge({ state }: { state: string }) {
  if (state === "owner_verified") return <span className="chip bg-trust-direct/10 text-trust-direct">✓ You added</span>;
  if (state === "observed") return <span className="chip bg-brand-soft text-brand-deep">auto-found</span>;
  return <span className="chip bg-surface-sunken text-ink-faint">unverified</span>;
}
