import { createServiceClient } from "@/lib/supabase/server";

/**
 * Google Business Profile (GBP) connector — the owner-authorized path to their
 * OWN reviews (all of them, 50/page — not the ≈5 the public Places API caps at)
 * AND the ability to POST replies, which closes the "Act on it" loop (draft →
 * actually send). OAuth 2.0 with the business.manage scope.
 *
 * DORMANT until configured (GBP_CLIENT_ID + GBP_CLIENT_SECRET) — same self-serve
 * pattern as the Apify features. Two Google-side prerequisites the owner must do:
 *   1) create an OAuth client in Google Cloud (+ set the two env vars),
 *   2) get Business Profile API access approved by Google (else 403).
 * Reviews + reply use the v4 endpoint; account/location discovery uses the newer
 * split APIs. The refresh token is stored on workspace.goals.gbp (service-role
 * gated) — fine for v1; move to an encrypted secret store when hardening.
 */

const SCOPE = "https://www.googleapis.com/auth/business.manage";
const AUTH = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN = "https://oauth2.googleapis.com/token";

export interface GbpConnection {
  refreshToken: string;
  accountName: string;   // "accounts/123"
  locationPath: string;  // "accounts/123/locations/456" (v4 review path)
  title?: string;
  connectedAt: string;
  lastSync?: string;
  reviewCount?: number;
}

export function gbpConfigured(): boolean {
  return !!(process.env.GBP_CLIENT_ID && process.env.GBP_CLIENT_SECRET);
}
const APP_URL = () => (process.env.NEXT_PUBLIC_APP_URL || "https://insights.askrani.ai").replace(/\/$/, "");
export const redirectUri = () => `${APP_URL()}/api/gbp/auth/callback`;

/** Build the Google consent URL. `state` carries the workspace to connect. */
export function authUrl(state: string): string {
  const p = new URLSearchParams({
    client_id: process.env.GBP_CLIENT_ID!,
    redirect_uri: redirectUri(),
    response_type: "code",
    scope: SCOPE,
    access_type: "offline",
    prompt: "consent",
    state,
  });
  return `${AUTH}?${p.toString()}`;
}

async function tokenRequest(body: Record<string, string>): Promise<any> {
  const res = await fetch(TOKEN, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: process.env.GBP_CLIENT_ID!, client_secret: process.env.GBP_CLIENT_SECRET!, ...body }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`gbp token: ${data.error_description || data.error || res.status}`);
  return data;
}
export async function exchangeCode(code: string): Promise<{ access_token: string; refresh_token?: string }> {
  return tokenRequest({ code, grant_type: "authorization_code", redirect_uri: redirectUri() });
}
async function accessFrom(refreshToken: string): Promise<string> {
  const d = await tokenRequest({ refresh_token: refreshToken, grant_type: "refresh_token" });
  return d.access_token as string;
}

async function gapi(url: string, accessToken: string, init?: RequestInit): Promise<any> {
  const res = await fetch(url, { ...init, headers: { authorization: `Bearer ${accessToken}`, "content-type": "application/json", ...(init?.headers ?? {}) } });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`gbp ${res.status}: ${data?.error?.message || JSON.stringify(data).slice(0, 200)}`);
  return data;
}

/** First account + its first location (auto-pick for v1). */
export async function discoverLocation(accessToken: string): Promise<{ accountName: string; locationPath: string; title?: string } | null> {
  const accts = await gapi("https://mybusinessaccountmanagement.googleapis.com/v1/accounts", accessToken);
  const accountName: string | undefined = accts.accounts?.[0]?.name;
  if (!accountName) return null;
  const locs = await gapi(`https://mybusinessbusinessinformation.googleapis.com/v1/${accountName}/locations?readMask=name,title&pageSize=100`, accessToken);
  const loc = locs.locations?.[0];
  if (!loc?.name) return null;
  const locId = String(loc.name).split("/").pop();
  return { accountName, locationPath: `${accountName}/locations/${locId}`, title: loc.title };
}

const STAR: Record<string, number> = { ONE: 1, TWO: 2, THREE: 3, FOUR: 4, FIVE: 5 };
export interface GbpReview { name: string; rating: number | null; comment: string; author?: string; createTime?: string; replied: boolean }

/** All reviews for the location (paginated, 50/page). */
export async function listReviews(refreshToken: string, locationPath: string, max = 400): Promise<GbpReview[]> {
  const access = await accessFrom(refreshToken);
  const out: GbpReview[] = [];
  let pageToken = "";
  do {
    const url = `https://mybusiness.googleapis.com/v4/${locationPath}/reviews?pageSize=50${pageToken ? `&pageToken=${pageToken}` : ""}`;
    const data = await gapi(url, access);
    for (const r of data.reviews ?? []) {
      out.push({
        name: r.name,
        rating: STAR[r.starRating] ?? null,
        comment: String(r.comment ?? "").replace(/\s+/g, " ").trim(),
        author: r.reviewer?.displayName,
        createTime: r.createTime,
        replied: !!r.reviewReply?.comment,
      });
    }
    pageToken = data.nextPageToken ?? "";
  } while (pageToken && out.length < max);
  return out;
}

/** Post (or update) the owner's reply to a review. Publishes public content. */
export async function replyToReview(refreshToken: string, reviewName: string, comment: string): Promise<void> {
  const access = await accessFrom(refreshToken);
  await gapi(`https://mybusiness.googleapis.com/v4/${reviewName}/reply`, access, { method: "PUT", body: JSON.stringify({ comment }) });
}

// ── connection storage (workspace.goals.gbp) ────────────────────────────────
export async function getConnection(workspaceId: string): Promise<GbpConnection | null> {
  const svc = createServiceClient();
  const { data } = await svc.from("workspace").select("goals").eq("id", workspaceId).maybeSingle();
  return ((data?.goals as any)?.gbp as GbpConnection) ?? null;
}
export async function saveConnection(workspaceId: string, patch: Partial<GbpConnection>): Promise<void> {
  const svc = createServiceClient();
  const { data } = await svc.from("workspace").select("goals").eq("id", workspaceId).maybeSingle();
  const goals = (data?.goals as Record<string, any>) ?? {};
  await svc.from("workspace").update({ goals: { ...goals, gbp: { ...(goals.gbp ?? {}), ...patch } } }).eq("id", workspaceId);
}
export async function disconnect(workspaceId: string): Promise<void> {
  const svc = createServiceClient();
  const { data } = await svc.from("workspace").select("goals").eq("id", workspaceId).maybeSingle();
  const goals = (data?.goals as Record<string, any>) ?? {};
  delete goals.gbp;
  await svc.from("workspace").update({ goals }).eq("id", workspaceId);
}
