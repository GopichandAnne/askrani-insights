"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { type Source, SOURCES_SENTINEL } from "@/lib/ask-shared";

/**
 * "Ask Rani" command bar (⌘K). Two modes in one bar:
 *  • Jump — type an intent ("prices", "changes") → routes you to a section.
 *  • Ask — type a real question ("what's my cheapest competitor?") → answered
 *    inline by Claude over YOUR collected data (via /api/ask), grounded so it
 *    never invents numbers.
 */

export interface Command {
  label: string;
  href: string;
  hint: string;
  icon: string;
  keywords: string[];
}

const COMMANDS: Command[] = [
  { label: "Today", href: "/", icon: "🏠", hint: "What changed + what to do", keywords: ["overview", "home", "dashboard", "summary", "start"] },
  { label: "Market feed", href: "/feed", icon: "📡", hint: "Every change, newest first", keywords: ["changes", "events", "activity", "timeline", "price drop", "new dish", "moved", "happened", "week"] },
  { label: "Offers & pricing", href: "/offers", icon: "💸", hint: "Prices & listings, you vs rivals", keywords: ["price", "prices", "pricing", "menu", "dishes", "products", "cost of items", "compare", "cheap", "expensive"] },
  { label: "Competitors", href: "/competitors", icon: "🧭", hint: "Your local rivals", keywords: ["rivals", "competition", "nearby", "businesses", "who", "compete"] },
  { label: "Recommendations", href: "/recommendations", icon: "🎯", hint: "What to do next", keywords: ["actions", "advice", "suggestions", "next moves", "todo", "ideas", "grow"] },
  { label: "Market report", href: "/reports", icon: "📊", hint: "Full report · export · cost", keywords: ["report", "export", "pdf", "csv", "download", "summary", "monitoring cost", "spend", "budget"] },
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
  let i = 0;
  for (const ch of label) if (ch === s[i]) i++;
  return i === s.length ? 30 : 0;
}

function isQuestionLike(s: string): boolean {
  const t = s.trim().toLowerCase();
  if (!t) return false;
  if (t.endsWith("?")) return true;
  if (/^(what|which|who|whose|whom|how|when|where|why|is|are|am|do|does|did|can|could|should|would|will|list|show|tell|compare|find|give|name|rank|top|cheapest|highest|lowest|best|worst|average|most|least|any)\b/.test(t)) return true;
  return t.split(/\s+/).length >= 4;
}

export function CommandPalette({ open, onClose, admin }: { open: boolean; onClose: () => void; admin?: boolean }) {
  const router = useRouter();
  const [q, setQ] = useState("");
  const [active, setActive] = useState(0);
  const [asked, setAsked] = useState<string | null>(null); // the question currently answered
  const [streaming, setStreaming] = useState(false);
  const [answerText, setAnswerText] = useState("");
  const [sources, setSources] = useState<Source[]>([]);
  const inputRef = useRef<HTMLInputElement>(null);

  const all = useMemo(() => (admin ? [...COMMANDS, ADMIN] : COMMANDS), [admin]);
  const results = useMemo(
    () => all.map((c) => ({ c, s: score(q, c) })).filter((x) => x.s > 0).sort((a, b) => b.s - a.s).map((x) => x.c),
    [q, all],
  );

  const showAsk = q.trim().length > 0;
  const topScore = results.length ? score(q, results[0]) : 0;
  const preferAsk = showAsk && (isQuestionLike(q) || topScore < 55);
  // combined list: [ask?, ...destinations]
  const items = useMemo(
    () => [...(showAsk ? [{ type: "ask" as const }] : []), ...results.map((c) => ({ type: "dest" as const, c }))],
    [showAsk, results],
  );

  useEffect(() => {
    if (open) { setQ(""); setActive(0); setAsked(null); setAnswerText(""); setSources([]); setStreaming(false); setTimeout(() => inputRef.current?.focus(), 20); }
  }, [open]);
  useEffect(() => { setActive(preferAsk ? 0 : showAsk ? 1 : 0); }, [q]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!open) return null;

  const go = (href: string) => { onClose(); router.push(href); };

  async function runAsk(question: string) {
    setAsked(question);
    setAnswerText("");
    setSources([]);
    setStreaming(true);
    try {
      const res = await fetch("/api/ask/stream", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ question }) });
      if (!res.ok || !res.body) { setAnswerText("I couldn't reach the assistant just now. Please try again."); return; }
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let acc = "";
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        acc += dec.decode(value, { stream: true });
        const i = acc.indexOf(SOURCES_SENTINEL);
        setAnswerText(i >= 0 ? acc.slice(0, i) : acc); // hide the trailing sources block from the visible answer
      }
      const i = acc.indexOf(SOURCES_SENTINEL);
      if (i >= 0) {
        try { setSources(JSON.parse(acc.slice(i + SOURCES_SENTINEL.length)) as Source[]); } catch { /* ignore */ }
      }
    } catch {
      setAnswerText("I couldn't reach the assistant just now. Please try again.");
    } finally {
      setStreaming(false);
    }
  }

  const onEnter = () => {
    const sel = items[active];
    if (!sel) { if (showAsk) runAsk(q.trim()); return; }
    if (sel.type === "ask") runAsk(q.trim());
    else go(sel.c.href);
  };

  const answering = asked !== null;

  return (
    <div className="fixed inset-0 z-[60] flex items-start justify-center px-4 pt-[11vh]" onMouseDown={onClose} role="dialog" aria-modal="true">
      <div className="absolute inset-0 animate-fade-in bg-navy/30 backdrop-blur-sm" aria-hidden />
      <div className="glass-strong relative w-full max-w-xl animate-fade-up overflow-hidden rounded-3xl" onMouseDown={(e) => e.stopPropagation()}>
        {/* input */}
        <div className="flex items-center gap-3 border-b border-line/60 px-4 py-3">
          <span className="text-lg text-brand" aria-hidden>✦</span>
          <input
            ref={inputRef}
            value={q}
            onChange={(e) => { setQ(e.target.value); if (asked !== null) { setAsked(null); setAnswerText(""); setSources([]); } }}
            onKeyDown={(e) => {
              if (e.key === "ArrowDown") { e.preventDefault(); setActive((a) => Math.min(a + 1, items.length - 1)); }
              else if (e.key === "ArrowUp") { e.preventDefault(); setActive((a) => Math.max(a - 1, 0)); }
              else if (e.key === "Enter") { e.preventDefault(); onEnter(); }
              else if (e.key === "Escape") onClose();
            }}
            placeholder="Ask Rani or jump to anything…  (try “what's my cheapest competitor?”)"
            className="w-full border-0 bg-transparent p-0 text-base outline-none placeholder:text-ink-faint focus:ring-0"
            style={{ boxShadow: "none" }}
          />
          <kbd className="hidden shrink-0 rounded-md bg-white/70 px-1.5 py-0.5 text-[10px] font-semibold text-ink-faint sm:block">ESC</kbd>
        </div>

        {/* body */}
        <div className="max-h-[56vh] overflow-auto p-2">
          {answering ? (
            <AnswerPanel asked={asked!} streaming={streaming} text={answerText} sources={sources} onGo={go} onAskAnother={() => { setAsked(null); setAnswerText(""); setSources([]); inputRef.current?.focus(); }} />
          ) : (
            <>
              {showAsk && (
                <button
                  onMouseEnter={() => setActive(0)}
                  onClick={() => runAsk(q.trim())}
                  data-active={active === 0}
                  className="mb-1 flex w-full items-center gap-3 rounded-2xl px-3 py-2.5 text-left transition-colors data-[active=true]:bg-brand-soft"
                >
                  <span className="grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-brand-gradient text-white shadow-brand">✦</span>
                  <span className="min-w-0">
                    <span className="block truncate text-sm font-semibold text-ink">Ask Rani: “{q.trim()}”</span>
                    <span className="block truncate text-xs text-ink-faint">Answer from your own market data</span>
                  </span>
                  <span className="ml-auto shrink-0 text-xs font-medium text-brand">{active === 0 ? "↵" : ""}</span>
                </button>
              )}

              {results.length > 0 && (
                <>
                  {showAsk && <div className="px-3 pb-1 pt-2 text-[11px] font-semibold uppercase tracking-wide text-ink-faint">Jump to</div>}
                  <ul>
                    {results.map((c, i) => {
                      const idx = showAsk ? i + 1 : i;
                      return (
                        <li key={c.href}>
                          <button
                            onMouseEnter={() => setActive(idx)}
                            onClick={() => go(c.href)}
                            data-active={idx === active}
                            className="flex w-full items-center gap-3 rounded-2xl px-3 py-2.5 text-left transition-colors data-[active=true]:bg-brand-soft"
                          >
                            <span className="grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-white/70 text-lg">{c.icon}</span>
                            <span className="min-w-0">
                              <span className="block truncate text-sm font-semibold text-ink">{c.label}</span>
                              <span className="block truncate text-xs text-ink-faint">{c.hint}</span>
                            </span>
                            {idx === active && <span className="ml-auto shrink-0 text-xs font-medium text-brand">↵</span>}
                          </button>
                        </li>
                      );
                    })}
                  </ul>
                </>
              )}

              {!showAsk && (
                <div className="px-3 py-2 text-[11px] text-ink-faint">
                  Try “prices”, “changes this week”, “who has the best rating?”, or “what should I do?”
                </div>
              )}
            </>
          )}
        </div>

        <div className="flex items-center justify-between border-t border-line/60 px-4 py-2 text-[11px] text-ink-faint">
          <span className="flex items-center gap-1"><span className="font-semibold text-brand-deep">Ask Rani</span> · answers from your data</span>
          <span className="hidden sm:block">↑↓ move · ↵ select · esc close</span>
        </div>
      </div>
    </div>
  );
}

const SOURCE_EMOJI: Record<string, string> = {
  website: "🌐", pdf: "📄", google: "🔵", yelp: "⭐", instagram: "📸",
  facebook: "👍", tiktok: "🎵", youtube: "▶️", doordash: "🛵", ubereats: "🛵", news: "📰",
};

function AnswerPanel({ asked, streaming, text, sources, onGo, onAskAnother }: { asked: string; streaming: boolean; text: string; sources: Source[]; onGo: (href: string) => void; onAskAnother: () => void }) {
  // Show the sources the answer actually cited ([n]); if it cited none, fall back
  // to the top few we drew on, so provenance is always visible.
  const citedIds = Array.from(new Set([...text.matchAll(/\[(\d+)\]/g)].map((m) => Number(m[1]))));
  const cited = sources.filter((s) => citedIds.includes(s.id));
  const shown = cited.length ? cited : sources.slice(0, 4);

  return (
    <div className="p-1.5">
      <div className="mb-2 flex items-start gap-2 rounded-2xl bg-white/55 p-3">
        <span className="grid h-8 w-8 shrink-0 place-items-center rounded-xl bg-surface-sunken text-sm">🗨️</span>
        <span className="pt-1 text-sm font-medium text-ink">{asked}</span>
      </div>

      <div className="flex items-start gap-2 rounded-2xl bg-brand-soft/50 p-3">
        <span className="grid h-8 w-8 shrink-0 place-items-center rounded-xl bg-brand-gradient text-white shadow-brand">✦</span>
        <div className="min-w-0 flex-1">
          {streaming && !text ? (
            <span className="rani-dots" aria-label="Thinking"><span /><span /><span /></span>
          ) : (
            <p className="whitespace-pre-wrap text-sm text-ink" aria-live="polite">
              {text}
              {streaming && <span className="ask-caret" aria-hidden />}
            </p>
          )}
        </div>
      </div>

      {!streaming && shown.length > 0 && (
        <div className="mt-3">
          <div className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-ink-faint">
            {cited.length ? "Sources" : "Based on"}
          </div>
          <div className="flex flex-wrap gap-1.5">
            {shown.map((s) => {
              const inner = (
                <>
                  <span aria-hidden>{SOURCE_EMOJI[s.platform] ?? "•"}</span>
                  {cited.length ? <span className="font-semibold">[{s.id}]</span> : null} {s.label}
                  <span className="text-ink-faint"> · {s.business}</span>
                </>
              );
              return s.url ? (
                <a key={s.id} href={s.url} target="_blank" rel="noreferrer" className="chip bg-white/70 text-ink-soft transition-colors hover:text-brand hover:shadow-glow">
                  {inner}
                </a>
              ) : (
                <span key={s.id} className="chip bg-white/70 text-ink-soft">{inner}</span>
              );
            })}
          </div>
        </div>
      )}

      {!streaming && text && (
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <button onClick={onAskAnother} className="btn btn-secondary px-3 py-1.5 text-xs">Ask another</button>
          <button onClick={() => onGo("/reports")} className="btn btn-secondary px-3 py-1.5 text-xs">Open full report</button>
          <button onClick={() => onGo("/feed")} className="btn btn-secondary px-3 py-1.5 text-xs">See sources</button>
          <span className="ml-auto text-[11px] text-ink-faint">Grounded in your collected data</span>
        </div>
      )}
    </div>
  );
}
