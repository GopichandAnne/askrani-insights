import crypto from "node:crypto";

/**
 * Deep-link tokens for the brief. A brief (email/WhatsApp) carries a signed link
 * that lands the owner AUTHENTICATED on a specific item in one tap — no login
 * wall. Unlike sso.ts (cross-app, minted by the Rani host), this token is minted
 * AND consumed by Insights: self-signed, keyed to ONE owner + workspace + target
 * path, short-lived. Same dependency-free HS256 scheme (node crypto only); we
 * accept only HS256 and reject alg:"none". Env-gated on BRIEF_LINK_SECRET.
 *
 * The link grants a session, so it's a bearer credential like a magic-link —
 * hence the short TTL and the server-only signing secret. Email is already a
 * trusted channel to the owner, so this is the same trust posture as a magic-link.
 */

export interface BriefClaims { email: string; ws: string; to: string }

const TTL_DAYS = 10;

function b64url(buf: Buffer): string {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function b64urlToBuf(s: string): Buffer {
  return Buffer.from(s.replace(/-/g, "+").replace(/_/g, "/"), "base64");
}

export function isBriefLinkConfigured(): boolean {
  return !!process.env.BRIEF_LINK_SECRET;
}

/** Mint a signed deep-link. Returns the full URL, or null if not configured.
 *  `to` must be a local path (e.g. "/brief" or "/brief#i-…" or "/offers"). */
export function mintBriefLink(origin: string, email: string, workspaceId: string, to = "/brief", ttlDays = TTL_DAYS): string | null {
  const secret = process.env.BRIEF_LINK_SECRET;
  if (!secret) return null;
  const path = to.startsWith("/") && !to.startsWith("//") ? to : "/brief";
  const header = b64url(Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })));
  const payload = b64url(Buffer.from(JSON.stringify({
    aud: "brief",
    email: email.trim().toLowerCase(),
    ws: workspaceId,
    to: path,
    exp: Math.floor(Date.now() / 1000) + ttlDays * 86400,
  })));
  const sig = b64url(crypto.createHmac("sha256", secret).update(`${header}.${payload}`).digest());
  return `${origin.replace(/\/$/, "")}/l?token=${header}.${payload}.${sig}`;
}

/** Verify a brief deep-link token. Returns the claims, or null with a reason for logs. */
export function verifyBriefToken(token: string): { claims: BriefClaims | null; reason?: string } {
  const secret = process.env.BRIEF_LINK_SECRET;
  if (!secret) return { claims: null, reason: "not_configured" };
  if (!token || token.split(".").length !== 3) return { claims: null, reason: "malformed" };

  const [h, p, sig] = token.split(".");
  let header: any;
  try { header = JSON.parse(b64urlToBuf(h).toString("utf8")); } catch { return { claims: null, reason: "bad_header" }; }
  if (header?.alg !== "HS256") return { claims: null, reason: "bad_alg" };

  const expected = crypto.createHmac("sha256", secret).update(`${h}.${p}`).digest();
  const provided = b64urlToBuf(sig);
  if (expected.length !== provided.length || !crypto.timingSafeEqual(expected, provided)) {
    return { claims: null, reason: "bad_signature" };
  }

  let payload: any;
  try { payload = JSON.parse(b64urlToBuf(p).toString("utf8")); } catch { return { claims: null, reason: "bad_payload" }; }

  const now = Math.floor(Date.now() / 1000);
  if (typeof payload.exp !== "number" || now > payload.exp) return { claims: null, reason: "expired" };
  if (payload.aud !== "brief") return { claims: null, reason: "bad_audience" };
  const email = typeof payload.email === "string" ? payload.email.trim().toLowerCase() : "";
  if (!email || !email.includes("@")) return { claims: null, reason: "no_email" };
  const ws = typeof payload.ws === "string" ? payload.ws : "";
  if (!ws) return { claims: null, reason: "no_ws" };
  const to = typeof payload.to === "string" && payload.to.startsWith("/") && !payload.to.startsWith("//") ? payload.to : "/brief";

  return { claims: { email, ws, to } };
}
