"use client";

import { useEffect, useState } from "react";

interface Status { configured: boolean; connected: boolean; title: string | null; lastSync: string | null; reviewCount: number | null }

/**
 * Connect Google Business Profile — the owner authorizes once, and we can then
 * pull ALL their reviews (not the ≈5 the public API caps at) and post replies.
 * Self-contained: reads its own status so it can drop onto any page.
 */
export function GbpConnect() {
  const [s, setS] = useState<Status | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  async function load() { try { const r = await fetch("/api/gbp/status"); if (r.ok) setS(await r.json()); } catch { /* ignore */ } }
  useEffect(() => { load(); }, []);

  async function sync() {
    setSyncing(true); setMsg(null);
    try {
      const r = await fetch("/api/gbp/sync", { method: "POST" });
      const d = await r.json();
      if (!r.ok) setMsg(d.error ?? "Sync failed"); else { setMsg(`Synced ${d.synced} reviews (${d.unreplied} awaiting a reply).`); load(); }
    } catch (e) { setMsg((e as Error).message); } finally { setSyncing(false); }
  }

  if (!s) return null;

  return (
    <section className="card">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="flex items-center gap-2 font-semibold">
            <span className="grid h-7 w-7 place-items-center rounded-lg bg-brand-soft text-brand">🟢</span>
            Google Business Profile
          </h2>
          <p className="mt-1 max-w-xl text-sm text-ink-soft">
            Connect your Google listing to read <span className="font-medium text-ink">all</span> your reviews (not just the few the public API shows) and reply to them straight from here.
          </p>
        </div>
        {s.connected ? (
          <span className="chip bg-trust-high/15 text-trust-high">Connected{s.title ? ` · ${s.title}` : ""}</span>
        ) : (
          <span className="chip bg-surface-sunken text-ink-faint">Not connected</span>
        )}
      </div>

      {!s.configured && (
        <p className="mt-3 rounded-xl bg-surface-sunken px-3 py-2 text-xs text-ink-faint">
          Setup pending: an admin needs to add the Google OAuth credentials and get Business Profile API access approved before this can be connected.
        </p>
      )}

      <div className="mt-4 flex flex-wrap items-center gap-2">
        {s.configured && !s.connected && (
          <a href="/api/gbp/auth/start" className="btn btn-primary px-4 py-2 text-sm">Connect Google Business Profile →</a>
        )}
        {s.connected && (
          <>
            <button onClick={sync} disabled={syncing} className="btn btn-primary px-4 py-2 text-sm disabled:opacity-60">
              {syncing ? "Syncing…" : "Sync my reviews"}
            </button>
            {s.reviewCount != null && <span className="text-xs text-ink-faint">{s.reviewCount} reviews{s.lastSync ? ` · last synced ${new Date(s.lastSync).toLocaleDateString()}` : ""}</span>}
          </>
        )}
      </div>
      {msg && <p className="mt-2 text-xs text-brand-deep">{msg}</p>}
    </section>
  );
}
