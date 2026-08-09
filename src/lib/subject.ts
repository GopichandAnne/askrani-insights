/**
 * Workspace subject polymorphism. A workspace is either:
 *  - 'business' — anchored to a target_business_id ("you" vs competitors), or
 *  - 'area'     — a zip/location + optional keyword, NO "you". The watched set is
 *                 every business found in the area; surfaces render as a pure
 *                 market view, and Your Edge reframes to "the opening here".
 *
 * The subject lives in workspace.goals (JSONB) so no schema change is needed:
 *   goals.subjectType = 'area', goals.subject = { area, keyword, center }.
 * A workspace with a target_business_id is always 'business'.
 */

export type SubjectType = "business" | "area";

export interface AreaSubject {
  area: string;
  keyword: string | null;
  center: { lat: number; lng: number } | null;
}

type WsLike = { target_business_id?: string | null; goals?: Record<string, unknown> | null };

export function subjectType(ws: WsLike): SubjectType {
  if (ws.target_business_id) return "business";
  const g = (ws.goals ?? {}) as Record<string, unknown>;
  if (g.subjectType === "area") return "area";
  const subj = g.subject as { area?: unknown } | undefined;
  if (subj && typeof subj.area === "string") return "area";
  return "business";
}

export const isAreaMode = (ws: WsLike): boolean => subjectType(ws) === "area";

export function areaSubject(ws: WsLike): AreaSubject | null {
  if (subjectType(ws) !== "area") return null;
  const subj = ((ws.goals ?? {}) as Record<string, unknown>).subject as Partial<AreaSubject> | undefined;
  return {
    area: typeof subj?.area === "string" ? subj.area : "your area",
    keyword: typeof subj?.keyword === "string" ? subj.keyword : null,
    center: subj?.center && typeof subj.center.lat === "number" ? subj.center : null,
  };
}

/** Human label for an area subject — "Med spas · 78701" / "Businesses · Austin". */
export function areaLabel(s: AreaSubject): string {
  const what = s.keyword ? s.keyword.replace(/\b\w/g, (c) => c.toUpperCase()) : "Businesses";
  return `${what} · ${s.area}`;
}
