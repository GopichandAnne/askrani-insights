"use client";

import { useState } from "react";
import type { ContentIdea, ContentType, ContentFormat } from "@/lib/contentplan";
import { DraftButton } from "@/components/DraftButton";

const TYPE_META: Record<ContentType, { label: string; chip: string }> = {
  promotional: { label: "Promo", chip: "bg-coral/15 text-coral-dark" },
  educational: { label: "Educational", chip: "bg-brand-soft text-brand-deep" },
  seasonal: { label: "Seasonal", chip: "bg-amber-400/20 text-amber-700" },
  behind_the_scenes: { label: "Behind the scenes", chip: "bg-violet-400/15 text-violet-700" },
  social_proof: { label: "Social proof", chip: "bg-trust-direct/15 text-trust-direct" },
  spotlight: { label: "Spotlight", chip: "bg-surface-sunken text-ink-soft" },
};
const FORMAT_LABEL: Record<ContentFormat, string> = { reel: "🎬 Reel", photo: "📷 Photo", carousel: "🖼️ Carousel", story: "⚡ Story" };

function IdeaCard({ idea }: { idea: ContentIdea }) {
  const [copied, setCopied] = useState(false);
  const tags = idea.hashtags.map((h) => `#${h}`).join(" ");
  const toCopy = idea.caption + (tags ? `\n\n${tags}` : "");
  const t = TYPE_META[idea.type] ?? TYPE_META.spotlight;

  async function copy() {
    try { await navigator.clipboard.writeText(toCopy); setCopied(true); setTimeout(() => setCopied(false), 1500); } catch { /* clipboard unavailable */ }
  }

  return (
    <div className="card flex flex-col gap-2.5">
      <div className="flex flex-wrap items-center gap-1.5">
        <span className={`chip font-semibold ${t.chip}`}>{t.label}</span>
        <span className="chip bg-surface-sunken text-ink-faint">{FORMAT_LABEL[idea.format] ?? idea.format}</span>
        {idea.timing && <span className="chip bg-white/60 text-ink-soft">🗓️ {idea.timing}</span>}
      </div>

      <div>
        <p className="text-sm font-semibold text-ink">{idea.hook}</p>
        <p className="mt-0.5 text-xs text-ink-faint">About: <span className="font-medium text-ink-soft">{idea.offering}</span></p>
      </div>

      <div className="rounded-2xl bg-white/60 p-3">
        <p className="whitespace-pre-wrap text-sm text-ink">{idea.caption}</p>
        {tags && <p className="mt-2 text-xs font-medium text-brand-deep">{tags}</p>}
      </div>

      <div className="mt-auto flex flex-wrap items-center gap-2">
        <button
          onClick={copy}
          className="inline-flex min-h-[38px] items-center gap-1 rounded-full bg-brand-gradient px-3.5 py-2 text-xs font-semibold text-white shadow-brand transition-opacity hover:opacity-90"
        >
          {copied ? "Copied ✓" : "📋 Copy caption"}
        </button>
        <DraftButton move={`${idea.hook} — a ${idea.type.replace(/_/g, " ")} post about ${idea.offering}`} context={`Offerings content plan · ${idea.format}`} />
        {idea.cta && <span className="text-xs text-ink-faint">→ {idea.cta}</span>}
      </div>
    </div>
  );
}

/** "Post about what you sell" — the offerings content plan, grounded in the
 *  business's own menu/services. Copy a caption or refine it into a full draft. */
export function ContentPlanBoard({ ideas }: { ideas: ContentIdea[] }) {
  const [showAll, setShowAll] = useState(false);
  if (!ideas.length) return null;
  const shown = showAll ? ideas : ideas.slice(0, 6);
  return (
    <>
      <div className="grid items-start gap-4 md:grid-cols-2">
        {shown.map((idea, i) => <IdeaCard key={i} idea={idea} />)}
      </div>
      {ideas.length > 6 && (
        <button
          onClick={() => setShowAll((v) => !v)}
          className="mt-3 inline-flex cursor-pointer items-center gap-1 rounded-xl px-3 py-2 text-xs font-semibold text-brand-deep hover:bg-brand-soft/60"
        >
          {showAll ? "Show fewer" : `Show ${ideas.length - 6} more idea${ideas.length - 6 === 1 ? "" : "s"}`} <span aria-hidden>›</span>
        </button>
      )}
    </>
  );
}
