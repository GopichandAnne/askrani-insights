"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import Link from "next/link";

/**
 * Search-first onboarding (guide §2.2): find your business → auto-discover &
 * rank competitors → collection runs in the BACKGROUND (a worker drains the
 * queue). The page just enqueues and watches progress; you can close the tab.
 */

interface Candidate {
  name: string;
  website?: string;
  geo?: { lat: number; lng: number };
  category?: string;
  address?: string;
  platform: string;
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

export function SearchFlow() {
  const [phase, setPhase] = useState<"search" | "workspace">("search");
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<Candidate[]>([]);
  const [searching, setSearching] = useState(false);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [workspaceId, setWorkspaceId] = useState<string | null>(null);
  const [target, setTarget] = useState<Target | null>(null);
  const [competitors, setCompetitors] = useState<Competitor[]>([]);
  const [jobs, setJobs] = useState<Record<string, Job>>({});
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

  useEffect(() => {
    return () => {
      if (pollRef.current) clearTimeout(pollRef.current);
    };
  }, []);

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

  async function pickBusiness(cand: Candidate) {
    setError(null);
    setCreating(true);
    try {
      const res = await fetch("/api/workspace/create", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ candidate: cand }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "could not create workspace");
      setWorkspaceId(data.workspaceId);
      setTarget(data.target);
      setCompetitors(data.competitors ?? []);
      setPhase("workspace");
      poll(data.workspaceId); // collection was enqueued server-side; watch it
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setCreating(false);
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

  // ── search phase ──────────────────────────────────────────────────────
  if (phase === "search") {
    return (
      <div className="space-y-5">
        <form onSubmit={onSearch} className="rounded-xl border border-line bg-surface p-6">
          <label className="block text-sm font-medium">Find your business</label>
          <p className="mb-3 text-sm text-ink-faint">Search by name and city — e.g. “Katz’s Delicatessen New York”.</p>
          <div className="flex gap-2">
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Business name and location"
              className="w-full rounded-lg border border-line px-3 py-2 text-sm"
            />
            <button
              type="submit"
              disabled={searching || query.trim().length < 2}
              className="rounded-lg bg-brand px-4 py-2 text-sm font-medium text-white disabled:opacity-60"
            >
              {searching ? "Searching…" : "Search"}
            </button>
          </div>
        </form>
        {error && <p className="rounded-lg border border-trust-low/30 bg-trust-low/5 p-3 text-sm text-trust-low">{error}</p>}
        {results.length > 0 && (
          <div className="space-y-2">
            {results.map((r, i) => (
              <div key={i} className="flex items-center justify-between gap-3 rounded-lg border border-line bg-surface p-3">
                <div className="min-w-0">
                  <div className="font-medium">{r.name}</div>
                  <div className="truncate text-xs text-ink-faint">
                    {r.address ?? ""} {r.website ? `· ${safeHost(r.website)}` : "· no website on record"}
                  </div>
                </div>
                <button
                  onClick={() => pickBusiness(r)}
                  disabled={creating}
                  className="shrink-0 rounded-lg border border-brand px-3 py-1.5 text-sm font-medium text-brand disabled:opacity-60"
                >
                  {creating ? "Setting up…" : "This is my business"}
                </button>
              </div>
            ))}
          </div>
        )}
        {searching && <p className="text-sm text-ink-faint">Searching OpenStreetMap…</p>}
      </div>
    );
  }

  // ── workspace phase ───────────────────────────────────────────────────
  const businesses = [
    ...(target ? [{ id: target.businessId, name: target.name, isTarget: true }] : []),
    ...competitors.map((c) => ({ id: c.businessId, name: c.name, isTarget: false })),
  ];
  const done = businesses.filter((b) => jobs[b.id]?.status === "done" || jobs[b.id]?.status === "error").length;
  const anyActive = businesses.some((b) => {
    const s = jobs[b.id]?.status;
    return s === "pending" || s === "running";
  });
  const started = Object.keys(jobs).length > 0;
  const allDone = started && !anyActive && done > 0;

  return (
    <div className="space-y-6">
      <div className="rounded-xl border border-brand bg-brand-soft/30 p-4">
        <div className="text-xs uppercase tracking-wide text-brand">Your business</div>
        <div className="font-medium">{target?.name}</div>
        {target?.website && <div className="text-xs text-ink-faint">{target.website}</div>}
        {target && <div className="mt-2"><StatusPill j={jobs[target.businessId]} /></div>}
      </div>

      <div className="rounded-xl border border-line bg-surface p-4">
        <div className="flex items-center justify-between">
          <div className="font-medium">Collection {allDone ? "complete" : "running in the background"}</div>
          <div className="text-sm text-ink-faint">{done}/{businesses.length} done</div>
        </div>
        <div className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-surface-sunken">
          <div className="h-full bg-brand transition-all" style={{ width: `${businesses.length ? (done / businesses.length) * 100 : 0}%` }} />
        </div>
        {!allDone ? (
          <p className="mt-2 text-xs text-ink-faint">
            A background worker crawls each site and extracts offers — you can leave this page.
            Make sure it’s running: <code>npm run worker</code>.
          </p>
        ) : (
          <div className="mt-3 flex flex-wrap gap-3 text-sm">
            <Link href="/offers" className="text-brand underline">View offers →</Link>
            <Link href="/recommendations" className="text-brand underline">View recommendations →</Link>
            <Link href="/feed" className="text-brand underline">View feed →</Link>
          </div>
        )}
      </div>

      <div>
        <div className="relative mb-2 flex items-center justify-between">
          <h2 className="font-semibold">Competitors ({competitors.length})</h2>
          <AddCompetitor onAdd={(c) => { setCompetitors((cs) => [...cs, c]); if (workspaceId) poll(workspaceId); }} workspaceId={workspaceId!} runSearch={runSearch} />
        </div>
        {competitors.length === 0 ? (
          <p className="rounded-lg border border-dashed border-line p-4 text-sm text-ink-faint">
            No competitors auto-found (OpenStreetMap coverage varies). Add some manually above, or connect Google for better coverage.
          </p>
        ) : (
          <ul className="space-y-1.5">
            {competitors.map((c) => (
              <li key={c.edgeId} className="flex items-center justify-between gap-2 rounded-lg border border-line bg-surface p-3 text-sm">
                <span className="min-w-0">
                  <span className="font-medium">{c.name}</span>
                  <span className="ml-2 text-xs text-ink-faint">
                    {c.distanceKm != null ? `${c.distanceKm}km` : ""} {c.website ? "· 🌐" : ""} · {c.relation}
                  </span>
                </span>
                <span className="flex items-center gap-2">
                  <StatusPill j={jobs[c.businessId]} />
                  <button onClick={() => removeCompetitor(c.edgeId)} className="text-ink-faint hover:text-trust-low" title="Remove">✕</button>
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

function StatusPill({ j }: { j?: Job }) {
  if (!j) return <span className="chip bg-surface-sunken text-ink-faint">queued</span>;
  if (j.status === "pending") return <span className="chip bg-surface-sunken text-ink-faint">queued</span>;
  if (j.status === "running") return <span className="chip bg-brand-soft text-brand">collecting…</span>;
  if (j.status === "error") return <span className="chip bg-trust-low/10 text-trust-low" title={j.error ?? ""}>failed</span>;
  const o = j.result?.offersWritten ?? 0;
  const r = j.result?.reviews ?? 0;
  return <span className="chip bg-trust-direct/10 text-trust-direct">{o} offers{r ? ` · ${r} reviews` : ""}</span>;
}

function safeHost(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

function AddCompetitor({
  onAdd,
  workspaceId,
  runSearch,
}: {
  onAdd: (c: Competitor) => void;
  workspaceId: string;
  runSearch: (q: string) => Promise<Candidate[]>;
}) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const [results, setResults] = useState<Candidate[]>([]);
  const [busy, setBusy] = useState(false);

  async function search() {
    setBusy(true);
    try {
      setResults(await runSearch(q.trim()));
    } finally {
      setBusy(false);
    }
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
      if (res.ok) {
        onAdd(data.competitor);
        setOpen(false);
        setQ("");
        setResults([]);
      }
    } finally {
      setBusy(false);
    }
  }

  if (!open)
    return (
      <button onClick={() => setOpen(true)} className="rounded-lg border border-line px-3 py-1 text-sm">
        + Add competitor
      </button>
    );

  return (
    <div className="absolute right-0 top-8 z-10 w-80 rounded-xl border border-line bg-surface p-3 shadow-lg">
      <div className="flex gap-2">
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && search()}
          placeholder="Search a competitor"
          className="w-full rounded-lg border border-line px-2 py-1 text-sm"
        />
        <button onClick={search} disabled={busy} className="rounded-lg bg-brand px-2 py-1 text-xs text-white">Go</button>
      </div>
      <div className="mt-2 max-h-56 space-y-1 overflow-auto">
        {results.map((r, i) => (
          <button key={i} onClick={() => add(r)} className="block w-full rounded-lg px-2 py-1 text-left text-sm hover:bg-surface-sunken">
            {r.name} <span className="text-xs text-ink-faint">{r.website ? safeHost(r.website) : ""}</span>
          </button>
        ))}
      </div>
      <button onClick={() => setOpen(false)} className="mt-2 text-xs text-ink-faint">close</button>
    </div>
  );
}
