"use client";

import { useState, useRef, useEffect } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { verticalEmoji } from "@/lib/classify";

export interface WsOption {
  id: string;
  name: string;
  vertical: string;
}

/** Business (workspace) switcher — a login can watch many businesses; this lets
 *  them choose which one they're viewing. Persists the pick via /api/workspace/active. */
export function WorkspaceSwitcher({ workspaces, activeId }: { workspaces: WsOption[]; activeId: string }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [switching, setSwitching] = useState<string | null>(null);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const h = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); };
    document.addEventListener("mousedown", h);
    return () => document.removeEventListener("mousedown", h);
  }, []);

  const active = workspaces.find((w) => w.id === activeId) ?? workspaces[0];
  if (!active) return null;

  async function pick(id: string) {
    if (id === activeId) { setOpen(false); return; }
    setSwitching(id);
    await fetch("/api/workspace/active", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ workspaceId: id }),
    });
    setOpen(false);
    setSwitching(null);
    router.refresh();
  }

  const icon = (v: string) => verticalEmoji(v);

  return (
    <div ref={ref} className="relative">
      <button
        onClick={() => setOpen((o) => !o)}
        className="glass flex items-center gap-2 rounded-full px-3 py-2 text-sm font-medium text-ink transition-all hover:shadow-glow"
        title="Switch business"
      >
        <span aria-hidden>{icon(active.vertical)}</span>
        <span className="max-w-[9rem] truncate sm:max-w-[12rem]">{active.name}</span>
        {workspaces.length > 1 && (
          <span className="chip bg-brand-soft px-1.5 py-0.5 text-[10px] text-brand-deep">{workspaces.length}</span>
        )}
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" className="text-ink-faint"><path d="m6 9 6 6 6-6" /></svg>
      </button>

      {open && (
        <div className="glass-strong absolute left-0 top-11 z-50 w-72 rounded-2xl p-1.5 shadow-glow">
          <div className="px-2.5 py-1.5 text-[11px] font-semibold uppercase tracking-wide text-ink-faint">Your businesses</div>
          <ul className="max-h-80 space-y-0.5 overflow-auto">
            {workspaces.map((w) => (
              <li key={w.id}>
                <button
                  onClick={() => pick(w.id)}
                  className={`flex w-full items-center gap-2.5 rounded-xl px-2.5 py-2 text-left text-sm transition-colors hover:bg-brand-soft ${w.id === activeId ? "bg-brand-soft/60" : ""}`}
                >
                  <span aria-hidden>{icon(w.vertical)}</span>
                  <span className="min-w-0 flex-1 truncate">{w.name}</span>
                  {switching === w.id ? (
                    <span className="rani-dots scale-75" aria-hidden><span /><span /><span /></span>
                  ) : w.id === activeId ? (
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" className="text-brand"><path d="M20 6 9 17l-5-5" /></svg>
                  ) : null}
                </button>
              </li>
            ))}
          </ul>
          <Link
            href="/onboarding"
            onClick={() => setOpen(false)}
            className="mt-1 flex items-center gap-2 rounded-xl px-2.5 py-2 text-sm font-medium text-brand hover:bg-brand-soft"
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 5v14M5 12h14" /></svg>
            Add a business
          </Link>
        </div>
      )}
    </div>
  );
}
