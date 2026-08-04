import crypto from "node:crypto";

/**
 * Inbound SSO from the Ask Rani platform (the host). The host mints a short-lived
 * HS256 JWT signed with a shared secret (INSIGHTS_SSO_SECRET, set identically in
 * both projects) asserting that a user is entitled to Insights. We verify it and
 * provision/sign-in the matching Insights user. Dependency-free (node crypto) so
 * there's no JWT library to trust; we accept only HS256 and reject "none".
 *
 * Token contract (claims):
 *   iss: "askrani"            (informational)
 *   aud: "insights"           (required — must match)
 *   email: string             (required — the identity we key on)
 *   sub?: string              (Rani user id, for stable linking)
 *   name?: string, org?: string (optional, for display/provisioning)
 *   insights_access: true     (required — the super-admin grant)
 *   exp: number (unix seconds) (required — keep TTL short, e.g. 120s)
 */

export interface SsoClaims {
  email: string;
  sub?: string;
  name?: string;
  org?: string;
}

function b64urlToBuf(s: string): Buffer {
  return Buffer.from(s.replace(/-/g, "+").replace(/_/g, "/"), "base64");
}

export function isSsoConfigured(): boolean {
  return !!process.env.INSIGHTS_SSO_SECRET;
}

/** Verify a host-issued token. Returns the claims, or null with a reason for logs. */
export function verifyInboundToken(token: string): { claims: SsoClaims | null; reason?: string } {
  const secret = process.env.INSIGHTS_SSO_SECRET;
  if (!secret) return { claims: null, reason: "not_configured" };
  if (!token || token.split(".").length !== 3) return { claims: null, reason: "malformed" };

  const [h, p, sig] = token.split(".");

  // header must declare HS256 — never trust alg:"none" or an asymmetric alg
  let header: any;
  try { header = JSON.parse(b64urlToBuf(h).toString("utf8")); } catch { return { claims: null, reason: "bad_header" }; }
  if (header?.alg !== "HS256") return { claims: null, reason: "bad_alg" };

  // constant-time signature check
  const expected = crypto.createHmac("sha256", secret).update(`${h}.${p}`).digest();
  const provided = b64urlToBuf(sig);
  if (expected.length !== provided.length || !crypto.timingSafeEqual(expected, provided)) {
    return { claims: null, reason: "bad_signature" };
  }

  let payload: any;
  try { payload = JSON.parse(b64urlToBuf(p).toString("utf8")); } catch { return { claims: null, reason: "bad_payload" }; }

  const now = Math.floor(Date.now() / 1000);
  if (typeof payload.exp !== "number" || now > payload.exp) return { claims: null, reason: "expired" };
  if (payload.aud !== "insights") return { claims: null, reason: "bad_audience" };
  if (payload.insights_access !== true) return { claims: null, reason: "not_entitled" };
  const email = typeof payload.email === "string" ? payload.email.trim().toLowerCase() : "";
  if (!email || !email.includes("@")) return { claims: null, reason: "no_email" };

  return {
    claims: {
      email,
      sub: typeof payload.sub === "string" ? payload.sub : undefined,
      name: typeof payload.name === "string" ? payload.name : undefined,
      org: typeof payload.org === "string" ? payload.org : undefined,
    },
  };
}
