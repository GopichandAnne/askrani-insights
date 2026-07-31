"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import Link from "next/link";
import { RaniSpinner, RaniMark } from "@/components/RaniSpinner";
import { subtypeLabel } from "@/lib/classify";

/**
 * Search-first onboarding (guide §2.2): find your business → we auto-detect its
 * type (restaurant/grocery) and cuisine, then rank *like-for-like* competitors →
 * you review/curate → YOU press "Start collecting". Nothing is scraped until
 * that explicit action.
 */

type Vertical = "restaurant" | "grocery";
interface Candidate {
  name: string;
  website?: string;
  geo?: { lat: number; lng: number };
  category?: string;
  address?: string;
  platform: string;
  detectedVertical?: Vertical;
  subtype?: string[];
  raw?: unknown;
}
interface Competitor {
  edgeId: string;
  businessId: string;
  name: string;
  website?: string;
  distanceKm?: number;
  relation: string;
  score: number;
}
interface Target {
  businessId: string;
  name: string;
  website?: string;
  geo?: { lat: number; lng: number };
}
interface Job {
  business_id: string;
  status: "pending" | "running" | "done" | "error";
  result?: { offersWritten?: number; pagesFetched?: number; reviews?: number } | null;
  error?: string | null;
}

function VerticalTag({ v, subtype }: { v?: Vertical; subtype?: string[] }) {
  const label = v === "grocery" ? "🛒 Grocery" : "🍽️ Restaurant";
  const sub = subtypeLabel(subtype ?? []);
  return (
    <span className="chip bg-brand-soft text-brand-deep">
      {label}
      {sub ? ` · ${sub}` : ""}
    </span>
  );
}

const STEPS = ["Find your business", "Review competitors", "Collect"];
function StepBar({ current }: { current: number }) {
  return (
    <ol className="flex items-center gap-2">
      {STEPS.map((label, i) => {
        const done = i < current;
        const active = i === current;
        return (
          <li key={label} className="flex flex-1 items-center gap-2">
            <span
              className={`grid h-7 w-7 shrink-0 place-items-center rounded-full text-xs font-bold transition-colors ${
                active ? "bg-brand-gradient text-white shadow-brand" : done ? "bg-brand-deep text-white" : "bg-white/70 text-ink-faint"
              }`}
            >
              {done ? "✓" : i + 1}
            </span>
            <span className={`hidden text-sm font-medium sm:inline ${active || done ? "text-ink" : "text-ink-faint"}`}>{label}</span>
            {i < STEPS.length - 1 && <span className={`h-px flex-1 ${done ? "bg-brand-deep/50" : "bg-line"}`} />}
          </li>
        );
      })}
    </ol>
  );
}

export function SearchFlow() {
  const [phase, setPhase] = useState<"search" | "workspace">("search");
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<Candidate[]>([]);
  const [searching, setSearching] = useState(false);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [pickedCand, setPickedCand] = useState<Candidate | null>(null);
  const [vertical, setVertical] = useState<Vertical>("restaurant");
  const [subtype, setSubtype] = useState<string[]>([]);
  const [workspaceId, setWorkspaceId] = useState<string | null>(null);
  const [target, setTarget] = useState<Target | null>(null);
  const [competitors, setCompetitors] = useState<Competitor[]>([]);
  const [jobs, setJobs] = useState<Record<string, Job>>({});
  const [started, setStarted] = useState(false);
  const [starting, setStarting] = useState(false);
  const pollRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  async function runSearch(q: string): Promise<Candidate[]> {
    const res = await fetch("/api/discover/search", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ query: q }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error ?? "search failed");
    return data.results as Candidate[];
  }

  const poll = useCallback(async (wsId: string) => {
    try {
      const res = await fetch(`/api/collect/status?workspaceId=${wsId}`, { cache: "no-store" });
      const data = await res.json();
      if (res.ok) {
        const map: Record<string, Job> = {};
        for (const j of data.jobs as Job[]) map[j.business_id] = j;
        setJobs(map);
        const active = (data.jobs as Job[]).some((j) => j.status === "pending" || j.status === "running");
        if (active) pollRef.current = setTimeout(() => poll(wsId), 3000);
      }
    } catch {
      pollRef.current = setTimeout(() => poll(wsId), 5000);
    }
  }, []);

  useEffect(() => () => { if (pollRef.current) clearTimeout(pollRef.current); }, []);

  async function onSearch(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setSearching(true);
    try {
      setResults(await runSearch(query.trim()));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSearching(false);
    }
  }

  async function resolve(cand: Candidate, overrideVertical?: Vertical) {
    setError(null);
    setCreating(true);
    try {
      const res = await fetch("/api/workspace/create", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ candidate: cand, vertical: overrideVertical ?? cand.detectedVertical }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "could not create workspace");
      setPickedCand(cand);
      setWorkspaceId(data.workspaceId);
      setVertical(data.vertical as Vertical);
      setSubtype((data.subtype as string[]) ?? []);
      setTarget(data.target);
      setCompetitors(data.competitors ?? []);
      setJobs({});
      setStarted(false);
      setPhase("workspace");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setCreating(false);
    }
  }

  async function changeVertical(v: Vertical) {
    if (v === vertical || !pickedCand) return;
    await resolve(pickedCand, v);
  }

  async function startCollection() {
    if (!workspaceId) return;
    setStarting(true);
    try {
      const res = await fetch("/api/collect/start", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ workspaceId }),
      });
      if (res.ok) {
        setStarted(true);
        poll(workspaceId);
      }
    } finally {
      setStarting(false);
    }
  }

  async function removeCompetitor(edgeId: string) {
    setCompetitors((cs) => cs.filter((c) => c.edgeId !== edgeId));
    await fetch("/api/competitors/remove", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ edgeId }),
    });
  }

  const stepIndex = phase === "search" ? 0 : started ? 2 : 1;

  return (
    <div className="space-y-6">
      <div className="card"><StepBar current={stepIndex} /></div>

      {phase === "search" ? (
        <SearchPhase
          {...{ query, setQuery, onSearch, searching, creating, error, results, resolve }}
        />
      ) : (
        <WorkspacePhase
          {...{ target, vertical, subtype, started, creating, changeVertical, competitors, workspaceId, runSearch, setCompetitors, jobs, starting, startCollection, removeCompetitor }}
        />
      )}
    </div>
  );
}

// ── Search phase ──────────────────────────────────────────────────────────
function SearchPhase({
  query, setQuery, onSearch, searching, creating, error, results, resolve,
}: any) {
  return (
    <div className="space-y-5">
      <form onSubmit={onSearch} className="card">
        <label className="block text-lg font-bold">Find your business</label>
        <p className="mb-4 mt-1 text-sm text-ink-faint">
          Search by name and city — we&apos;ll figure out the rest (restaurant or grocery, cuisine, and
          your closest competitors). e.g. “Patel Brothers Edison NJ” or “Katz&apos;s Delicatessen New York”.
        </p>
        <div className="flex flex-col gap-2 sm:flex-row">
          <input
            value={query}
            onChange={(e: any) => setQuery(e.target.value)}
            placeholder="Business name and location"
            className="field flex-1"
          />
          <button type="submit" disabled={searching || query.trim().length < 2} className="btn btn-primary px-6 py-2.5 disabled:opacity-60">
            {searching ? "Searching…" : "Search"}
          </button>
        </div>
      </form>

      {error && <p className="rounded-xl border border-trust-low/30 bg-trust-low/5 p-3 text-sm text-trust-low">{error}</p>}

      {results.length > 0 && (
        <div className="stagger space-y-2">
          {results.map((r: Candidate, i: number) => (
            <div key={i} className="card card-hover flex items-center justify-between gap-3 py-3.5">
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-semibold">{r.name}</span>
                  <VerticalTag v={r.detectedVertical} subtype={r.subtype} />
                </div>
                <div className="mt-0.5 truncate text-xs text-ink-faint">
                  {r.address ?? ""} {r.website ? `· ${safeHost(r.website)}` : "· no website on record"}
                </div>
              </div>
              <button onClick={() => resolve(r)} disabled={creating} className="btn btn-primary shrink-0 px-4 py-2 text-sm disabled:opacity-60">
                {creating ? "Setting up…" : "This is mine"}
              </button>
            </div>
          ))}
        </div>
      )}
      {searching && <div className="card"><RaniSpinner label="Searching…" /></div>}
    </div>
  );
}

// ── Workspace phase ─────────────────────────────────────────────────────────
function WorkspacePhase({
  target, vertical, subtype, started, creating, changeVertical,
  competitors, workspaceId, runSearch, setCompetitors, jobs, starting, startCollection, removeCompetitor,
}: any) {
  const businesses = [
    ...(target ? [{ id: target.businessId, name: target.name, isTarget: true }] : []),
    ...competitors.map((c: Competitor) => ({ id: c.businessId, name: c.name, isTarget: false })),
  ];
  const done = businesses.filter((b: any) => jobs[b.id]?.status === "done" || jobs[b.id]?.status === "error").length;
  const anyActive = businesses.some((b: any) => ["pending", "running"].includes(jobs[b.id]?.status));
  const allDone = started && !anyActive && done > 0;

  return (
    <div className="space-y-6">
      {/* your business */}
      <div className="glass relative overflow-hidden rounded-2xl p-5">
        <div className="pointer-events-none absolute -right-8 -top-10 h-28 w-28 rounded-full bg-brand/15 blur-2xl" aria-hidden />
        <div className="relative flex flex-wrap items-start justify-between gap-3">
          <div className="flex items-center gap-3">
            <div className="grid h-11 w-11 place-items-center rounded-2xl bg-brand-gradient text-white shadow-brand"><RaniMark size={24} /></div>
            <div>
              <div className="text-xs uppercase tracking-wide text-brand-deep">Your business</div>
              <div className="font-display text-xl font-bold">{target?.name}</div>
              {target?.website && <div className="text-xs text-ink-faint">{target.website}</div>}
            </div>
          </div>
          <div className="text-right">
            <VerticalTag v={vertical} subtype={subtype} />
            {!started && (
              <div className="mt-1 text-xs text-ink-faint">
                Not a {vertical}?{" "}
                <button onClick={() => changeVertical(vertical === "grocery" ? "restaurant" : "grocery")} disabled={creating} className="font-medium text-brand underline disabled:opacity-60">
                  It&apos;s a {vertical === "grocery" ? "restaurant" : "grocery"}
                </button>
              </div>
            )}
          </div>
        </div>
        {started && target && <div className="relative mt-3"><StatusPill j={jobs[target.businessId]} /></div>}
      </div>

      {/* competitors */}
      <div className="card">
        <div className="relative mb-1 flex items-center justify-between">
          <h2 className="font-semibold">Competitors <span className="text-ink-faint">({competitors.length})</span></h2>
          <AddCompetitor onAdd={(c: Competitor) => setCompetitors((cs: Competitor[]) => [...cs, c])} workspaceId={workspaceId!} runSearch={runSearch} />
        </div>
        <p className="mb-3 text-xs text-ink-faint">
          {vertical === "grocery" ? "Grocers" : "Restaurants"} closest to yours by type &amp; distance — like-for-like first.
          Remove any that don&apos;t belong, add your own. Nothing is collected until you start.
        </p>
        {competitors.length === 0 ? (
          <p className="rounded-2xl border border-dashed border-line p-4 text-sm text-ink-faint">
            We couldn&apos;t find competitors automatically for this spot. No problem — add them with the “Add competitor” button.
          </p>
        ) : (
          <ul className="space-y-1.5">
            {competitors.map((c: Competitor) => (
              <li key={c.edgeId} className="flex items-center justify-between gap-2 rounded-2xl bg-white/50 p-3 text-sm">
                <span className="min-w-0">
                  <span className="font-medium">{c.name}</span>
                  <span className="ml-2 text-xs text-ink-faint">
                    {c.distanceKm != null ? `${c.distanceKm}km` : ""} {c.website ? "· 🌐" : ""} · {c.relation}
                  </span>
                </span>
                <span className="flex items-center gap-2">
                  {started && <StatusPill j={jobs[c.businessId]} />}
                  <button onClick={() => removeCompetitor(c.edgeId)} className="grid h-6 w-6 place-items-center rounded-full text-ink-faint hover:bg-trust-low/10 hover:text-trust-low" title="Remove">✕</button>
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>

      {/* start / progress */}
      {!started ? (
        <div className="glass-strong relative overflow-hidden rounded-2xl p-5">
          <div className="pointer-events-none absolute inset-0 bg-brand-mesh opacity-[0.08]" aria-hidden />
          <div className="relative flex flex-wrap items-center justify-between gap-3">
            <div>
              <div className="font-semibold">Ready when you are</div>
              <p className="text-sm text-ink-faint">
                We&apos;ll gather websites, menus, offers, reviews and social for you and the {competitors.length} competitor{competitors.length === 1 ? "" : "s"} above.
              </p>
            </div>
            <button onClick={startCollection} disabled={starting} className="btn btn-primary px-7 py-3 text-base disabled:opacity-60">
              {starting ? "Starting…" : "Start collecting"} <RaniMark size={18} />
            </button>
          </div>
        </div>
      ) : (
        <div className="card">
          <div className="flex items-center justify-between">
            <div className="font-semibold">Collection {allDone ? "complete" : "running in the background"}</div>
            <div className="text-sm text-ink-faint">{done}/{businesses.length} done</div>
          </div>
          <div className="mt-3 h-2 w-full overflow-hidden rounded-full bg-surface-sunken">
            <div className="h-full rounded-full bg-brand-gradient transition-all" style={{ width: `${businesses.length ? (done / businesses.length) * 100 : 0}%` }} />
          </div>
          {!allDone ? (
            <p className="mt-3 text-xs text-ink-faint">
              We&apos;re gathering everything about your market in the background — menus, prices, offers and
              reviews. This can take a few minutes. Feel free to leave this page; we&apos;ll keep working.
            </p>
          ) : (
            <div className="mt-4 flex flex-wrap gap-2">
              <Link href="/offers" className="btn btn-secondary px-4 py-2 text-sm">View offers</Link>
              <Link href="/recommendations" className="btn btn-secondary px-4 py-2 text-sm">Recommendations</Link>
              <Link href="/reports" className="btn btn-primary px-4 py-2 text-sm">View report →</Link>
            </div>
          )}
          <div className="mt-3">
            <button onClick={startCollection} disabled={starting} className="text-xs font-medium text-brand underline disabled:opacity-60">
              {starting ? "Queuing…" : "Collect any newly-added competitors"}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function StatusPill({ j }: { j?: Job }) {
  if (!j || j.status === "pending") return <span className="chip bg-surface-sunken text-ink-faint">queued</span>;
  if (j.status === "running") return <span className="chip bg-brand-soft text-brand">collecting…</span>;
  if (j.status === "error") return <span className="chip bg-trust-low/10 text-trust-low" title={j.error ?? ""}>failed</span>;
  const o = j.result?.offersWritten ?? 0;
  const r = j.result?.reviews ?? 0;
  return <span className="chip bg-trust-direct/10 text-trust-direct">{o} offers{r ? ` · ${r} reviews` : ""}</span>;
}

function safeHost(url: string): string {
  try { return new URL(url).host; } catch { return url; }
}

function AddCompetitor({ onAdd, workspaceId, runSearch }: { onAdd: (c: Competitor) => void; workspaceId: string; runSearch: (q: string) => Promise<Candidate[]> }) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const [results, setResults] = useState<Candidate[]>([]);
  const [busy, setBusy] = useState(false);

  async function search() {
    setBusy(true);
    try { setResults(await runSearch(q.trim())); } finally { setBusy(false); }
  }
  async function add(c: Candidate) {
    setBusy(true);
    try {
      const res = await fetch("/api/competitors/add", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ workspaceId, candidate: c }),
      });
      const data = await res.json();
      if (res.ok) { onAdd(data.competitor); setOpen(false); setQ(""); setResults([]); }
    } finally { setBusy(false); }
  }

  if (!open) return <button onClick={() => setOpen(true)} className="btn btn-secondary px-3 py-1.5 text-sm">+ Add competitor</button>;

  return (
    <div className="glass-strong absolute right-0 top-9 z-10 w-80 rounded-2xl p-3">
      <div className="flex gap-2">
        <input value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => e.key === "Enter" && search()} placeholder="Search a competitor" className="field flex-1 py-1.5" />
        <button onClick={search} disabled={busy} className="btn btn-primary px-3 py-1.5 text-xs">Go</button>
      </div>
      <div className="mt-2 max-h-56 space-y-1 overflow-auto">
        {results.map((r, i) => (
          <button key={i} onClick={() => add(r)} className="flex w-full items-center gap-2 rounded-xl px-2 py-1.5 text-left text-sm hover:bg-brand-soft">
            <span className="min-w-0 truncate">{r.name}</span>
            <span className="ml-auto shrink-0"><VerticalTag v={r.detectedVertical} subtype={r.subtype} /></span>
          </button>
        ))}
      </div>
      <button onClick={() => setOpen(false)} className="mt-2 text-xs text-ink-faint">close</button>
    </div>
  );
}
