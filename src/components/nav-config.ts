/**
 * Four-surface navigation model (Simplicity Product Direction v2, mobile-first):
 * TODAY / WATCH / GROW / ASK lead the nav; a section sub-nav switches between a
 * section's member pages; everything else lives under MORE. This is REPRESENTATION
 * ONLY — every route/page/pillar still exists and is reachable, just regrouped.
 * Icons are keys into AppNav's ICONS map.
 */
export interface NavMember { href: string; label: string; icon?: string; match?: string[] }
export interface NavSection { key: string; label: string; icon: string; href: string; match: string[]; members?: NavMember[] }

/** Path highlight test shared by the rail, bottom tabs and the section sub-nav. */
export const navHit = (pathname: string, paths: string[]): boolean =>
  paths.some((h) => (h === "/" ? pathname === "/" : pathname === h || pathname.startsWith(h + "/")));

// ── Target-business workspaces (the full product) ──────────────────────────
export const SECTIONS_NORMAL: NavSection[] = [
  { key: "today", label: "Today", icon: "today", href: "/brief", match: ["/brief", "/", "/edge"] },
  {
    key: "watch", label: "Watch", icon: "market", href: "/competitors",
    match: ["/competitors", "/inspiration", "/market", "/around", "/feed", "/offers"],
    members: [
      { href: "/competitors", label: "Competitors", match: ["/feed", "/offers"] },
      { href: "/inspiration", label: "Inspirations" },
      { href: "/market", label: "Market" },
      { href: "/around", label: "Around" },
    ],
  },
  {
    key: "grow", label: "Grow", icon: "winning", href: "/findability",
    match: ["/findability", "/content", "/rivals", "/festivals", "/winning", "/plan"],
    members: [
      { href: "/findability", label: "Findability" },
      { href: "/content", label: "Content" },
      { href: "/rivals", label: "Openings" },
      { href: "/festivals", label: "Festivals" },
      { href: "/winning", label: "What's winning" },
      { href: "/plan", label: "Plan" },
    ],
  },
  { key: "ask", label: "Ask", icon: "assistant", href: "/assistant", match: ["/assistant"] },
];
export const MORE_NORMAL: NavMember[] = [
  { href: "/", label: "This Week", icon: "edge" },
  { href: "/scorecard", label: "Market Position", icon: "scorecard" },
  { href: "/you", label: "You", icon: "you" },
  { href: "/channels", label: "Channels", icon: "channels" },
  { href: "/reports", label: "Report", icon: "report" },
  { href: "/billing", label: "Billing", icon: "billing" },
  { href: "/explore", label: "Watch a market", icon: "explore" },
  { href: "/onboarding", label: "New workspace", icon: "add" },
];

// ── Area workspaces (a watched zip/city, no "you") ─────────────────────────
export const SECTIONS_AREA: NavSection[] = [
  { key: "today", label: "Today", icon: "today", href: "/edge", match: ["/edge", "/"] },
  {
    key: "watch", label: "Watch", icon: "market", href: "/market",
    match: ["/market", "/feed", "/offers", "/competitors", "/around"],
    members: [
      { href: "/market", label: "Businesses", match: ["/feed", "/offers", "/competitors"] },
      { href: "/around", label: "Around" },
    ],
  },
  {
    key: "grow", label: "Grow", icon: "winning", href: "/winning", match: ["/winning", "/content"],
    members: [
      { href: "/winning", label: "What's winning" },
      { href: "/content", label: "Content" },
    ],
  },
  { key: "ask", label: "Ask", icon: "assistant", href: "/assistant", match: ["/assistant"] },
];
export const MORE_AREA: NavMember[] = [
  { href: "/reports", label: "Report", icon: "report" },
  { href: "/billing", label: "Billing", icon: "billing" },
  { href: "/explore", label: "Watch a market", icon: "explore" },
  { href: "/onboarding", label: "New workspace", icon: "add" },
];
