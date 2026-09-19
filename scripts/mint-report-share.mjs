// Mint a public report-share link for a workspace.
// Usage: node scripts/mint-report-share.mjs <workspaceId> [--expires-days N]
// Reads Supabase creds from .env.local. Requires the report_share table (0078).
import { readFileSync } from "node:fs";
import { randomBytes } from "node:crypto";

const env = {};
for (const line of readFileSync(new URL("../.env.local", import.meta.url), "utf8").split(/\r?\n/)) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/); if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, "");
}
const SUPA = env.NEXT_PUBLIC_SUPABASE_URL, KEY = env.SUPABASE_SERVICE_ROLE_KEY;
const BASE = "https://insights.askrani.ai";

const wsId = process.argv[2];
if (!wsId) { console.error("usage: node scripts/mint-report-share.mjs <workspaceId> [--expires-days N]"); process.exit(1); }
const di = process.argv.indexOf("--expires-days");
const expiresAt = di > -1 ? new Date(Date.now() + Number(process.argv[di + 1]) * 86400000).toISOString() : null;
const token = randomBytes(24).toString("base64url"); // ~192-bit, URL-safe

const H = { apikey: KEY, authorization: `Bearer ${KEY}`, "content-type": "application/json", prefer: "return=representation" };
const res = await fetch(`${SUPA}/rest/v1/report_share`, {
  method: "POST", headers: H,
  body: JSON.stringify({ token, workspace_id: wsId, status: "active", expires_at: expiresAt }),
});
const body = await res.json();
if (!res.ok) { console.error("mint failed", res.status, JSON.stringify(body)); process.exit(1); }
console.log("Minted report link:");
console.log(`  ${BASE}/r/${token}`);
console.log(`  workspace: ${wsId}${expiresAt ? ` · expires ${expiresAt.slice(0, 10)}` : " · no expiry"}`);
