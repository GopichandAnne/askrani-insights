"use client";

import { useEffect, useState } from "react";

/**
 * Team management (owners only). Lists the org's members, lets an owner add one by
 * email (owner or member), change a role, or remove someone — with the last-owner
 * protected. Mirrors the Rani app's team manager. Adding an email that has no
 * account yet sends them a sign-in invite; they land in this org on first login.
 */

type Role = "owner" | "member";
type Method = "email" | "phone";
interface Member { userId: string; email: string | null; phone: string | null; name: string | null; role: string; isSelf: boolean }

export function TeamCard() {
  const [members, setMembers] = useState<Member[] | null>(null);
  const [method, setMethod] = useState<Method>("email");
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
  const [name, setName] = useState("");
  const [role, setRole] = useState<Role>("member");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  async function load() {
    try {
      const r = await fetch("/api/team");
      const d = await r.json().catch(() => ({}));
      if (r.ok) setMembers(d.members ?? []);
      else setMembers([]);
    } catch { setMembers([]); }
  }
  useEffect(() => { void load(); }, []);

  const ownerCount = (members ?? []).filter((m) => m.role === "owner").length;

  async function post(body: Record<string, unknown>, okText: string) {
    setBusy(true); setMsg(null);
    try {
      const r = await fetch("/api/team", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      const d = await r.json().catch(() => ({}));
      if (r.ok && d.ok !== false) { setMsg({ ok: true, text: okText }); await load(); return true; }
      setMsg({ ok: false, text: d.error ?? "Something went wrong." });
      return false;
    } catch { setMsg({ ok: false, text: "Something went wrong." }); return false; }
    finally { setBusy(false); }
  }

  async function add() {
    if (busy) return;
    if (method === "email") {
      if (!email.trim()) return;
      const ok = await post({ action: "add", method: "email", email, name: name.trim() || undefined, role }, "Added — if they're new, we've emailed them a sign-in link.");
      if (ok) { setEmail(""); setName(""); setRole("member"); }
    } else {
      if (!phone.trim()) return;
      const ok = await post({ action: "add", method: "phone", phone, name: name.trim() || undefined, role }, "Added — ask them to sign in with this number (Phone tab); they'll get an SMS code.");
      if (ok) { setPhone(""); setName(""); setRole("member"); }
    }
  }

  return (
    <section className="card">
      <h2 className="font-semibold">Team</h2>
      <p className="mt-0.5 text-sm text-ink-faint">
        People who can access this account. <span className="font-medium text-ink-soft">Owners</span> manage the team, billing and settings; <span className="font-medium text-ink-soft">members</span> can view and act on your insights.
      </p>

      {/* roster */}
      <div className="mt-4 divide-y divide-line/50">
        {members === null ? (
          <p className="py-3 text-sm text-ink-faint">Loading team…</p>
        ) : members.length === 0 ? (
          <p className="py-3 text-sm text-ink-faint">Just you so far — add a teammate below.</p>
        ) : (
          members.map((m) => {
            const lastOwner = m.role === "owner" && ownerCount <= 1;
            return (
              <div key={m.userId} className="flex flex-wrap items-center gap-x-3 gap-y-2 py-3">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="truncate text-sm font-medium text-ink">{m.name || m.email || m.phone || "Pending invite"}</span>
                    {m.isSelf && <span className="chip bg-brand-soft text-brand">You</span>}
                    {lastOwner && <span className="chip bg-surface-sunken text-ink-faint">Last owner</span>}
                  </div>
                  {(m.name && (m.email || m.phone)) && <div className="truncate text-xs text-ink-faint">{m.email || m.phone}</div>}
                </div>
                <select
                  value={m.role === "owner" ? "owner" : "member"}
                  disabled={busy || lastOwner}
                  onChange={(e) => post({ action: "role", userId: m.userId, role: e.target.value }, "Role updated.")}
                  className="rounded-xl border border-line bg-surface px-2.5 py-1.5 text-sm outline-none focus:border-brand disabled:opacity-50"
                >
                  <option value="owner">Owner</option>
                  <option value="member">Member</option>
                </select>
                <button
                  onClick={() => post({ action: "remove", userId: m.userId }, "Removed.")}
                  disabled={busy || lastOwner}
                  className="text-xs font-medium text-coral-dark hover:underline disabled:opacity-40"
                >
                  Remove
                </button>
              </div>
            );
          })
        )}
      </div>

      {/* add member */}
      <div className="mt-4 rounded-2xl bg-surface-sunken/60 p-3">
        <div className="mb-2 flex items-center justify-between gap-2">
          <p className="text-xs font-semibold uppercase tracking-wide text-ink-faint">Add a teammate</p>
          {/* how they'll sign in */}
          <div className="flex rounded-lg bg-surface p-0.5 text-xs font-medium">
            {(["email", "phone"] as const).map((m) => (
              <button
                key={m}
                onClick={() => { setMethod(m); setMsg(null); }}
                className={`rounded-md px-2.5 py-1 capitalize transition-colors ${method === m ? "bg-brand-gradient text-white shadow-brand" : "text-ink-soft hover:text-ink"}`}
              >
                {m}
              </button>
            ))}
          </div>
        </div>
        <div className="flex flex-col gap-2 sm:flex-row">
          {method === "email" ? (
            <input
              type="email" value={email} onChange={(e) => setEmail(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && add()}
              placeholder="teammate@email.com"
              className="min-w-0 flex-1 rounded-xl border border-line bg-surface px-3 py-2 text-sm outline-none focus:border-brand focus:ring-2 focus:ring-brand/20"
            />
          ) : (
            <input
              type="tel" inputMode="tel" value={phone} onChange={(e) => setPhone(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && add()}
              placeholder="+1 512 555 0142"
              className="min-w-0 flex-1 rounded-xl border border-line bg-surface px-3 py-2 text-sm tabular-nums outline-none focus:border-brand focus:ring-2 focus:ring-brand/20"
            />
          )}
          <input
            value={name} onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && add()}
            placeholder="Name (optional)"
            className="rounded-xl border border-line bg-surface px-3 py-2 text-sm outline-none focus:border-brand focus:ring-2 focus:ring-brand/20 sm:w-40"
          />
          <select
            value={role} onChange={(e) => setRole(e.target.value as Role)}
            className="rounded-xl border border-line bg-surface px-2.5 py-2 text-sm outline-none focus:border-brand sm:w-32"
          >
            <option value="member">Member</option>
            <option value="owner">Owner</option>
          </select>
          <button onClick={add} disabled={busy || (method === "email" ? !email.trim() : !phone.trim())} className="btn btn-primary px-5 py-2 text-sm disabled:opacity-50">
            {busy ? "…" : "Add"}
          </button>
        </div>
        <p className="mt-2 text-[11px] text-ink-faint">
          {method === "email"
            ? "They sign in with this email — via a link, a password, or Google (same address)."
            : "They sign in on the Phone tab with an SMS code. Include the country code (e.g. +1). Needs SMS sign-in enabled."}
        </p>
        {msg && <p className={`mt-2 text-sm ${msg.ok ? "text-trust-direct" : "text-coral-dark"}`}>{msg.text}</p>}
      </div>
    </section>
  );
}
