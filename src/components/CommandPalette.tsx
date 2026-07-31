"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";

/**
 * "Ask Rani" command bar (⌘K / Ctrl+K). Intent-driven navigation: type what you
 * want in plain words ("prices", "what should I do", "changes this week") and it
 * routes you — no hunting through a fixed menu. Keyword synonyms make it feel
 * like it understands you, with zero backend.
 */

export interface Command {
  label: string;
  href: string;
  hint: string;
  icon: string; // emoji, kept tiny + friendly for non-tech users
  keywords: string[];
}

const COMMANDS: Command[] = [
  { label: "Today", href: "/", icon: "🏠", hint: "What changed + what to do", keywords: ["overview", "home", "dashboard", "summary", "start"] },
  { label: "Market feed", href: "/feed", icon: "📡", hint: "Every change, newest first", keywords: ["changes", "events", "activity", "timeline", "price drop", "new dish", "moved", "happened", "week"] },
  { label: "Offers & pricing", href: "/offers", icon: "💸", hint: "Menus & prices, you vs rivals", keywords: ["price", "prices", "pricing", "menu", "dishes", "products", "cost of items", "compare", "cheap", "expensive"] },
  { label: "Competitors", href: "/competitors", icon: "🧭", hint: "Your local rivals", keywords: ["rivals", "competition", "nearby", "businesses", "who", "compete"] },
  { label: "Recommendations", href: "/recommendations", icon: "🎯", hint: "What to do next", keywords: ["actions", "what should i do", "what to do", "advice", "suggestions", "next moves", "todo", "ideas", "grow"] },
  { label: "Market report", href: "/reports", icon: "📊", hint: "Full report · export · cost", keywords: ["report", "export", "pdf", "csv", "download", "summary", "reputation", "ratings", "monitoring cost", "spend", "budget"] },
  { label: "New workspace", href: "/onboarding", icon: "✨", hint: "Add / set up a business", keywords: ["add business", "onboard", "setup", "set up", "new", "another store", "find my business"] },
];

const ADMIN: Command = { label: "Admin", href: "/admin", icon: "🛡️", hint: "Platform health & sources", keywords: ["admin", "settings", "health", "sources", "keys", "status"] };

function score(q: string, c: Command): number {
  const s = q.toLowerCase().trim();
  if (!s) return 1;
  const label = c.label.toLowerCase();
  if (label.startsWith(s)) return 100;
  if (label.includes(s)) return 80;
  for (const k of c.keywords) {
    if (k === s) return 70;
    if (k.includes(s) || s.includes(k)) return 55;
  }
  // loose subsequence over label (typo/partial tolerance)
  let i = 0;
  for (const ch of label) if (ch === s[i]) i++;
  if (i === s.length) return 30;
  return 0;
}

export function CommandPalette({ open, onClose, admin }: { open: boolean; onClose: () => void; admin?: boolean }) {
  const router = useRouter();
  const [q, setQ] = useState("");
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  const all = useMemo(() => (admin ? [...COMMANDS, ADMIN] : COMMANDS), [admin]);
  const results = useMemo(
    () =>
      all
        .map((c) => ({ c, s: score(q, c) }))
        .filter((x) => x.s > 0)
        .sort((a, b) => b.s - a.s)
        .map((x) => x.c),
    [q, all],
  );

  useEffect(() => {
    if (open) {
      setQ("");
      setActive(0);
      setTimeout(() => inputRef.current?.focus(), 20);
    }
  }, [open]);
  useEffect(() => setActive(0), [q]);

  if (!open) return null;

  const go = (href: string) => {
    onClose();
    router.push(href);
  };

  return (
    <div
      className="fixed inset-0 z-[60] flex items-start justify-center px-4 pt-[12vh]"
      onMouseDown={onClose}
      role="dialog"
      aria-modal="true"
    >
      <div className="absolute inset-0 bg-navy/30 backdrop-blur-sm animate-fade-in" aria-hidden />
      <div
        className="glass-strong relative w-full max-w-xl overflow-hidden rounded-3xl animate-fade-up"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-3 border-b border-line/60 px-4 py-3">
          <span className="text-lg" aria-hidden>✦</span>
          <input
            ref={inputRef}
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "ArrowDown") { e.preventDefault(); setActive((a) => Math.min(a + 1, results.length - 1)); }
              else if (e.key === "ArrowUp") { e.preventDefault(); setActive((a) => Math.max(a - 1, 0)); }
              else if (e.key === "Enter") { e.preventDefault(); if (results[active]) go(results[active].href); }
              else if (e.key === "Escape") onClose();
            }}
            placeholder="Ask Rani or jump to anything…  (try “prices”, “what should I do”)"
            className="w-full border-0 bg-transparent p-0 text-base outline-none placeholder:text-ink-faint focus:ring-0"
            style={{ boxShadow: "none" }}
          />
          <kbd className="hidden shrink-0 rounded-md bg-white/70 px-1.5 py-0.5 text-[10px] font-semibold text-ink-faint sm:block">ESC</kbd>
        </div>

        <div className="max-h-[52vh] overflow-auto p-2">
          {results.length === 0 ? (
            <div className="px-3 py-6 text-center text-sm text-ink-faint">
              Nothing matches “{q}”. Try “prices”, “changes”, “report”, or “what to do”.
            </div>
          ) : (
            <ul>
              {results.map((c, i) => (
                <li key={c.href}>
                  <button
                    onMouseEnter={() => setActive(i)}
                    onClick={() => go(c.href)}
                    data-active={i === active}
                    className="flex w-full items-center gap-3 rounded-2xl px-3 py-2.5 text-left transition-colors data-[active=true]:bg-brand-soft"
                  >
                    <span className="grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-white/70 text-lg">{c.icon}</span>
                    <span className="min-w-0">
                      <span className="block truncate text-sm font-semibold text-ink">{c.label}</span>
                      <span className="block truncate text-xs text-ink-faint">{c.hint}</span>
                    </span>
                    {i === active && <span className="ml-auto shrink-0 text-xs font-medium text-brand">↵</span>}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>

        <div className="flex items-center justify-between border-t border-line/60 px-4 py-2 text-[11px] text-ink-faint">
          <span className="flex items-center gap-1"><span className="font-semibold text-brand-deep">Ask Rani</span> · type an intent, press ↵</span>
          <span className="hidden sm:block">↑↓ to move · esc to close</span>
        </div>
      </div>
    </div>
  );
}
