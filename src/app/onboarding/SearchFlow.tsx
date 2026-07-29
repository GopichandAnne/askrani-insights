"use client";

import { useState } from "react";
import Link from "next/link";

/**
 * Search-first onboarding (guide §2.2): find your business → auto-discover &
 * rank competitors → autonomously collect everything. No URLs to paste.
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
type CollectStatus = { state: "pending" | "running" | "done" | "error"; offers?: number; pages?: number; reviews?: number; error?: string };

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

  const [collecting, setCollecting] = useState(false);
  const [collectDone, setCollectDone] = useState(false);
  const [status, setStatus] = useState<Record<string, CollectStatus>>({});

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

  async function startCollection() {
    if (!target) return;
    setCollecting(true);
    setCollectDone(false);
    const businesses = [
      { id: target.businessId, name: target.name },
      ...competitors.map((c) => ({ id: c.businessId, name: c.name })),
    ];
    const init: Record<string, CollectStatus> = {};
    businesses.forEach((b) => (init[b.id] = { state: "pending" }));
    setStatus(init);

    for (const b of businesses) {
      setStatus((s) => ({ ...s, [b.id]: { state: "running" } }));
      try {
        const res = await fetch("/api/collect", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ businessId: b.id }),
        });
        const r = await res.json();
        setStatus((s) => ({
          ...s,
          [b.id]: r.ok
            ? { state: "done", offers: r.offersWritten, pages: r.pagesFetched, reviews: r.reviews }
            : { state: "error", error: r.error },
        }));
      } catch (e) {
        setStatus((s) => ({ ...s, [b.id]: { state: "error", error: (e as Error).message } }));
      }
    }

    // refresh recommendations from everything collected
    if (workspaceId) {
      await fetch("/api/recommendations/refresh", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ workspaceId }),
      }).catch(() => {});
    }
    setCollecting(false);
    setCollectDone(true);
  }

  // ── render ────────────────────────────────────────────────────────────
  if (phase === "search") {
    return (
      <div className="space-y-5">
        <form onSubmit={onSearch} className="rounded-xl border border-line bg-surface p-6">
          <label className="block text-sm font-medium">Find your business</label>
          <p className="mb-3 text-sm text-ink-faint">
            Search by name and city — e.g. “Katz’s Delicatessen New York”.
          </p>
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
                    {r.address ?? ""} {r.website ? `· ${new URL(r.website).host}` : "· no website on record"}
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

  // workspace phase
  return (
    <div className="space-y-6">
      <div className="rounded-xl border border-brand bg-brand-soft/30 p-4">
        <div className="text-xs uppercase tracking-wide text-brand">Your business</div>
        <div className="font-medium">{target?.name}</div>
        {target?.website && <div className="text-xs text-ink-faint">{target.website}</div>}
      </div>

      <div>
        <div className="mb-2 flex items-center justify-between">
          <h2 className="font-semibold">Competitors ({competitors.length})</h2>
          <AddCompetitor
            onAdd={(c) => setCompetitors((cs) => [...cs, c])}
            workspaceId={workspaceId!}
            runSearch={runSearch}
          />
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
                  {status[c.businessId] && <StatusPill s={status[c.businessId]} />}
                  {!collecting && (
                    <button onClick={() => removeCompetitor(c.edgeId)} className="text-ink-faint hover:text-trust-low" title="Remove">
                      ✕
                    </button>
                  )}
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="rounded-xl border border-line bg-surface p-4">
        {!collectDone ? (
          <>
            <div className="flex items-center justify-between">
              <div>
                <div className="font-medium">Collect everything available</div>
                <p className="text-sm text-ink-faint">
                  Crawls each business’s website, extracts offers, and pulls reviews (when Google is connected).
                </p>
              </div>
              <button
                onClick={startCollection}
                disabled={collecting}
                className="rounded-lg bg-brand px-4 py-2 text-sm font-medium text-white disabled:opacity-60"
              >
                {collecting ? "Collecting…" : "Start collection"}
              </button>
            </div>
            {target && status[target.businessId] && (
              <div className="mt-3 flex items-center gap-2 text-sm">
                <span className="font-medium">{target.name}</span>
                <StatusPill s={status[target.businessId]} />
              </div>
            )}
            {collecting && (
              <p className="mt-2 text-xs text-ink-faint">
                Each business is crawled + AI-extracted one at a time — this can take a minute or two per site. Leave the tab open.
              </p>
            )}
          </>
        ) : (
          <div className="space-y-3">
            <div className="text-sm font-medium text-trust-direct">Collection complete — your workspace is live.</div>
            <div className="flex flex-wrap gap-3 text-sm">
              <Link href="/offers" className="text-brand underline">View offers →</Link>
              <Link href="/recommendations" className="text-brand underline">View recommendations →</Link>
              <Link href="/feed" className="text-brand underline">View feed →</Link>
              <Link href="/competitors" className="text-brand underline">Manage competitors →</Link>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function StatusPill({ s }: { s: CollectStatus }) {
  if (s.state === "pending") return <span className="chip bg-surface-sunken text-ink-faint">queued</span>;
  if (s.state === "running") return <span className="chip bg-brand-soft text-brand">collecting…</span>;
  if (s.state === "error") return <span className="chip bg-trust-low/10 text-trust-low" title={s.error}>failed</span>;
  return (
    <span className="chip bg-trust-direct/10 text-trust-direct">
      {s.offers ?? 0} offers{s.reviews ? ` · ${s.reviews} reviews` : ""}
    </span>
  );
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
    <div className="absolute right-6 z-10 mt-8 w-80 rounded-xl border border-line bg-surface p-3 shadow-lg">
      <div className="flex gap-2">
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && search()}
          placeholder="Search a competitor"
          className="w-full rounded-lg border border-line px-2 py-1 text-sm"
        />
        <button onClick={search} disabled={busy} className="rounded-lg bg-brand px-2 py-1 text-xs text-white">
          Go
        </button>
      </div>
      <div className="mt-2 max-h-56 space-y-1 overflow-auto">
        {results.map((r, i) => (
          <button key={i} onClick={() => add(r)} className="block w-full rounded-lg px-2 py-1 text-left text-sm hover:bg-surface-sunken">
            {r.name} <span className="text-xs text-ink-faint">{r.website ? new URL(r.website).host : ""}</span>
          </button>
        ))}
      </div>
      <button onClick={() => setOpen(false)} className="mt-2 text-xs text-ink-faint">
        close
      </button>
    </div>
  );
}
