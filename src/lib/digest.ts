import { createServiceClient } from "@/lib/supabase/server";

/**
 * The weekly digest — the "push" that turns Insights from a dashboard you have
 * to remember to open into a feed that arrives. It reads the already-analyzed
 * pillar caches on workspace.goals (you / deals / flyerDeals / ads / demand /
 * winning / content / industryBest) and distills them into a short, ranked list
 * of "what changed and what to do." It is PURE + deterministic — no new scrape,
 * no LLM call, no cost — so it's safe to run on a cron. Each item can carry an
 * `act` spec so the owner can act on it in one tap (see act.ts / ActOnIt).
 *
 * "New since last digest" is tracked with a small fingerprint set on
 * goals.digestSeen so the push only shouts about things the owner hasn't seen.
 */

export type ActKind = "reply" | "promo" | "content";
export interface ActSpec { kind: ActKind; move: string; context?: string }

export interface DigestItem {
  id: string;                                    // stable key (drives "new" + dedup)
  severity: "alert" | "opportunity" | "fyi";
  pillar: string;                                // human label of the source pillar
  icon: string;
  title: string;
  detail: string;
  isNew?: boolean;
  act?: ActSpec;
  href?: string;                                 // drill-down into the full pillar
}

export interface Digest {
  headline: string;
  items: DigestItem[];
  alertCount: number;
  opportunityCount: number;
  newCount: number;
  generatedAt: string;
}

const clean = (s: unknown) => String(s ?? "").replace(/<\/?[a-z][^>]*>/gi, "").replace(/\s+/g, " ").trim();
const SEV_RANK: Record<DigestItem["severity"], number> = { alert: 0, opportunity: 1, fyi: 2 };

/**
 * Build the digest from a workspace's cached goals. Deterministic: same goals in,
 * same items out (ordering aside). `seenIds` marks which items are "new".
 */
export function buildDigest(
  ws: { name: string; vertical: string },
  goals: Record<string, any>,
  seenIds: string[] = [],
  now = new Date(),
): Digest {
  const seen = new Set(seenIds);
  const items: DigestItem[] = [];
  const push = (it: DigestItem) => { it.isNew = !seen.has(it.id); items.push(it); };

  // ── Reputation (goals.you) ────────────────────────────────────────────────
  const you = goals.you as any | undefined;
  const rep = you?.reputation;
  if (rep) {
    const vel = rep.velocity;
    if (vel && typeof vel.ratingDelta === "number" && vel.ratingDelta <= -0.1) {
      push({
        id: `rep:slip:${vel.ratingDelta.toFixed(1)}`,
        severity: "alert", pillar: "Reputation", icon: "📉",
        title: "Your rating is slipping",
        detail: `Down ${Math.abs(vel.ratingDelta).toFixed(1)}★ over the last ${vel.windowDays || "few"} days${
          typeof vel.reviewsAdded === "number" ? ` across ${vel.reviewsAdded} new reviews` : ""
        }. Get ahead of it.`,
        href: "/you",
      });
    }
    if (typeof rep.delta === "number" && rep.delta < -0.05 && rep.rating != null) {
      push({
        id: `rep:belowmkt:${rep.rating}`,
        severity: "alert", pillar: "Reputation", icon: "⭐",
        title: "You're rated below your market",
        detail: `You: ${rep.rating}★${rep.marketAvg != null ? ` vs market ${rep.marketAvg}★` : ""}${
          rep.rank && rep.total ? ` — rank #${rep.rank} of ${rep.total}` : ""
        }.`,
        href: "/you",
      });
    }
  }
  for (const r of ((you?.synthesis?.reviewsToAnswer ?? []) as any[]).slice(0, 2)) {
    const quote = clean(r.quote);
    if (!quote) continue;
    push({
      id: `rep:reply:${quote.slice(0, 40).toLowerCase()}`,
      severity: "alert", pillar: "Reputation", icon: "💬",
      title: "A review is waiting for your reply",
      detail: `“${quote.slice(0, 140)}${quote.length > 140 ? "…" : ""}”`,
      act: { kind: "reply", move: `Reply to this ${ws.name} review: "${quote}"`, context: clean(r.why) || clean(r.reply) },
      href: "/you",
    });
  }
  for (const p of ((you?.discoverability?.missing ?? []) as string[]).slice(0, 1)) {
    push({
      id: `rep:missing:${String(p).toLowerCase()}`,
      severity: "opportunity", pillar: "Listings", icon: "📇",
      title: `You're not listed on ${p}`,
      detail: `Customers look there for a business like yours. Claiming the listing is one more place they can find you.`,
      href: "/you",
    });
  }

  // ── Findability — where you rank in Google search vs competitors ──────────
  const fb = goals.findabilityBrief as any | undefined;
  if (fb && typeof fb.score === "number") {
    const slip = fb.biggestSlip;
    const realSlip = slip && slip.from != null && (slip.to == null || slip.to > slip.from);
    if (realSlip) {
      push({
        id: `find:slip:${clean(slip.term).slice(0, 30).toLowerCase()}:${slip.to ?? "x"}`,
        severity: "alert", pillar: "Findability", icon: "🔎",
        title: "You slipped in Google search",
        detail: `You're now ${slip.to ? `#${slip.to}` : "not ranking"} for “${clean(slip.term)}”${fb.topRival ? `; ${clean(fb.topRival)} is ahead of you` : ""}.`,
        act: fb.recommendation ? { kind: "content", move: clean(fb.recommendation) } : undefined,
        href: "/findability",
      });
    } else if (fb.coverage && fb.coverage.total && fb.coverage.inTop3 / fb.coverage.total < 0.5) {
      push({
        id: `find:cov:${fb.coverage.inTop3}-${fb.coverage.total}`,
        severity: "opportunity", pillar: "Findability", icon: "🔎",
        title: "Hard to find for most searches",
        detail: `You're top-3 for only ${fb.coverage.inTop3} of ${fb.coverage.total} customer searches${fb.topRival ? ` — ${clean(fb.topRival)} leads` : ""}.`,
        act: fb.recommendation ? { kind: "content", move: clean(fb.recommendation) } : undefined,
        href: "/findability",
      });
    }
  }

  // ── Review pulse — what's CHANGING in reviews, not just the current state ──
  const pulse = goals.pulse as any | undefined;
  if (pulse && !pulse.failed) {
    for (const e of ((pulse.emerging ?? []) as any[]).slice(0, 2)) {
      const theme = clean(e.theme);
      if (!theme) continue;
      push({
        id: `pulse:emerging:${theme.slice(0, 30).toLowerCase()}`,
        severity: "alert", pillar: "Reputation", icon: "📈",
        title: `Emerging complaint: ${theme}`,
        detail: clean(pulse.summary) || "Showing up more in recent reviews — get ahead of it before it spreads.",
        act: { kind: "content", move: `Get ahead of the growing concern about "${theme}" — an operational fix + a reassuring post`, context: clean(pulse.summary) },
        href: "/you",
      });
    }
    const rise = clean(((pulse.rising ?? []) as string[])[0]);
    if (rise) {
      push({
        id: `pulse:rising:${rise.slice(0, 30).toLowerCase()}`,
        severity: "opportunity", pillar: "Reputation", icon: "💚",
        title: `Customers increasingly love: ${rise}`,
        detail: "Rising in your recent reviews — make it the star of your next post.",
        act: { kind: "content", move: `Celebrate what customers increasingly love: ${rise}`, context: clean(pulse.summary) },
        href: "/you",
      });
    }
  }

  // ── Competitor deals (goals.deals + goals.flyerDeals), grouped by rival ────
  const captionDeals = ((goals.deals?.deals ?? []) as any[]).map((d) => ({ rival: clean(d.rival), deal: clean(d.deal) }));
  const flyerDeals = ((goals.flyerDeals?.deals ?? []) as any[]).map((d) => ({ rival: clean(d.rival), deal: `${clean(d.item)}${d.price ? ` — ${clean(d.price)}` : ""}` }));
  const byRival = new Map<string, string[]>();
  for (const d of [...flyerDeals, ...captionDeals].filter((d) => d.rival && d.deal)) {
    const list = byRival.get(d.rival) ?? [];
    if (!list.includes(d.deal)) list.push(d.deal);
    byRival.set(d.rival, list);
  }
  for (const [rival, deals] of [...byRival.entries()].slice(0, 3)) {
    const shown = deals.slice(0, 4);
    push({
      id: `deal:${rival.toLowerCase()}`,
      severity: "alert", pillar: "Competitor deals", icon: "🏷️",
      title: deals.length > 1 ? `${rival} is running ${deals.length} deals` : `${rival} is running a deal`,
      detail: shown.join(" · ") + (deals.length > shown.length ? ` · +${deals.length - shown.length} more` : ""),
      act: { kind: "promo", move: `Respond to ${rival}'s current offers (${shown.join("; ")}) with a compelling deal of our own`, context: `Competitor: ${rival}. Their deals: ${shown.join("; ")}.` },
      href: "/content",
    });
  }

  // ── Social pulse — what's breaking out / rising in rivals' content ─────────
  const sp = goals.socialPulse as any | undefined;
  if (sp && !sp.failed) {
    const b0 = (sp.breakouts ?? [])[0];
    if (b0?.rival) {
      push({
        id: `social:breakout:${clean(b0.rival).toLowerCase()}:${clean(b0.caption).slice(0, 20).toLowerCase()}`,
        severity: "opportunity", pillar: "Social", icon: "🚀",
        title: `${clean(b0.rival)}'s post is breaking out`,
        detail: `${b0.multiple}× their usual engagement — “${clean(b0.caption).slice(0, 90)}”. Make your version.`,
        act: { kind: "content", move: `Make our own version of the post that's working for ${clean(b0.rival)}: "${clean(b0.caption)}"`, context: clean(sp.summary) },
        href: "/content",
      });
    }
    const rf = clean(((sp.risingFormats ?? []) as string[])[0]);
    if (rf) {
      push({
        id: `social:rising:${rf.slice(0, 30).toLowerCase()}`,
        severity: "opportunity", pillar: "Social", icon: "📱",
        title: `Rising format locally: ${rf}`,
        detail: clean(sp.summary) || "Gaining traction in your market's content — worth trying.",
        act: { kind: "content", move: `Create a "${rf}" style post for us`, context: clean(sp.summary) },
        href: "/content",
      });
    }
    const nc = ((sp.newCollabs ?? []) as string[])[0];
    if (nc) {
      push({
        id: `social:collab:${String(nc).toLowerCase()}`,
        severity: "fyi", pillar: "Social", icon: "🤝",
        title: `New collab in your market: @${nc}`,
        detail: `A rival just started working with @${nc} — a creator you could partner with too.`,
        href: "/content",
      });
    }
  }

  // ── Competitor ads (goals.ads) ────────────────────────────────────────────
  const ads = goals.ads as any | undefined;
  if (ads && !ads.empty && (ads.advertisers?.length || ads.moves?.length)) {
    const move = clean(ads.moves?.[0]) || clean(ads.patterns?.[0]?.pattern);
    if (move) {
      push({
        id: `ads:move:${move.slice(0, 30).toLowerCase()}`,
        severity: "opportunity", pillar: "Competitor ads", icon: "📣",
        title: `Rivals are advertising${ads.advertisers?.length ? ` (${ads.advertisers.slice(0, 2).join(", ")})` : ""}`,
        detail: move,
        act: { kind: "promo", move, context: clean(ads.summary) },
        href: "/content",
      });
    }
  }

  // ── Unmet demand (goals.demand) ───────────────────────────────────────────
  for (const dm of ((goals.demand?.demands ?? []) as any[]).filter((d) => d.heat === "high" && (d.servedLocally === "no" || d.servedLocally === "few")).slice(0, 2)) {
    const need = clean(dm.need);
    if (!need) continue;
    push({
      id: `demand:${need.slice(0, 30).toLowerCase()}`,
      severity: "opportunity", pillar: "Unmet demand", icon: "🎯",
      title: `Unmet demand: ${need}`,
      detail: clean(dm.signal) || clean(dm.move),
      act: { kind: "content", move: clean(dm.move) || `Promote that we serve: ${need}`, context: clean(dm.signal) },
      href: "/winning",
    });
  }

  // ── Menu / offering gap to grab (goals.winning) ───────────────────────────
  const gap = ((goals.winning?.winning ?? []) as any[]).find((w) => w && w.onYourMenu === false);
  if (gap?.name) {
    push({
      id: `winning:gap:${clean(gap.name).toLowerCase()}`,
      severity: "opportunity", pillar: "What's winning", icon: "🍽️",
      title: `Gap to grab: ${clean(gap.name)}`,
      detail: clean(gap.signal) || `Winning around you but not on your menu yet.`,
      act: { kind: "content", move: `Announce that we now offer ${clean(gap.name)}`, context: clean(gap.signal) },
      href: "/winning",
    });
  }

  // ── Content idea of the week (goals.content / goals.industryBest) ──────────
  const idea = (goals.content?.swipe?.[0] ?? goals.industryBest?.best?.[0]) as any | undefined;
  if (idea?.yourVersion) {
    push({
      id: `content:idea:${clean(idea.yourVersion).slice(0, 30).toLowerCase()}`,
      severity: "fyi", pillar: "Content", icon: "✨",
      title: idea.format ? `Content idea: ${clean(idea.format)}` : "A post idea for this week",
      detail: clean(idea.yourVersion),
      act: { kind: "content", move: clean(idea.yourVersion), context: clean(idea.format) },
      href: "/content",
    });
  }

  // rank: severity, then new-first, then keep insertion order
  items.sort((a, b) => SEV_RANK[a.severity] - SEV_RANK[b.severity] || Number(!!b.isNew) - Number(!!a.isNew));
  const top = items.slice(0, 8);

  const alertCount = top.filter((i) => i.severity === "alert").length;
  const opportunityCount = top.filter((i) => i.severity === "opportunity").length;
  const newCount = top.filter((i) => i.isNew).length;
  const headline =
    alertCount > 0 ? `${alertCount} thing${alertCount > 1 ? "s" : ""} need${alertCount > 1 ? "" : "s"} your attention`
    : opportunityCount > 0 ? `${opportunityCount} opportunit${opportunityCount > 1 ? "ies" : "y"} this week`
    : top.length ? "A few ideas for this week"
    : "You're all caught up";

  return { headline, items: top, alertCount, opportunityCount, newCount, generatedAt: now.toISOString() };
}

/** Read-side: build the digest from the current cache and store it on goals.digest. */
export async function getOrMakeDigest(ws: { id: string; name: string; vertical: string }): Promise<Digest> {
  const svc = createServiceClient();
  const { data } = await svc.from("workspace").select("goals").eq("id", ws.id).maybeSingle();
  const goals = (data?.goals as Record<string, any>) ?? {};
  const digest = buildDigest(ws, goals, (goals.digestSeen?.ids as string[]) ?? []);
  await svc.from("workspace").update({ goals: { ...goals, digest } }).eq("id", ws.id).then(() => {}, () => {});
  return digest;
}

/** Mark the current items as seen so the next digest only flags what's new. */
export async function markDigestSeen(wsId: string, ids: string[], now = new Date()): Promise<void> {
  const svc = createServiceClient();
  const { data } = await svc.from("workspace").select("goals").eq("id", wsId).maybeSingle();
  const goals = (data?.goals as Record<string, any>) ?? {};
  await svc.from("workspace").update({ goals: { ...goals, digestSeen: { ids, at: now.toISOString() } } }).eq("id", wsId);
}
