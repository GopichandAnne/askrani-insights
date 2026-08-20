import { NextResponse } from "next/server";
import { resolveStoreForEmail, sharedWalletConfigured } from "@/lib/raniWallet";

export const dynamic = "force-dynamic";

/**
 * TEMP diagnostic (WORKER_SECRET-gated) for verifying the email→Rani-store resolve
 * chain end to end — Insights `resolveStoreForEmail` → Rani `wallet` edge fn
 * (resolve_store) → the 0084 owner-email RPC — WITHOUT exposing the shared OPS
 * secret (it stays in the server env). `sharedWalletConfigured` also reports whether
 * RANI_WALLET_URL + RANI_OPS_SECRET are set in this environment. Remove after test.
 *
 *   GET /api/diag/rani-link?email=<email>&secret=<WORKER_SECRET>
 */
export async function GET(req: Request) {
  const secret = process.env.WORKER_SECRET || process.env.CRON_SECRET || "";
  const url = new URL(req.url);
  const authz = req.headers.get("authorization") ?? "";
  const provided = authz.startsWith("Bearer ") ? authz.slice(7) : (url.searchParams.get("secret") ?? "");
  if (!secret || provided !== secret) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const email = (url.searchParams.get("email") ?? "").trim().toLowerCase();
  const store = email ? await resolveStoreForEmail(email) : null;

  // Raw resolve_store call so we can see exactly what the Rani wallet fn returns
  // (e.g. {error:"unknown action"} = fn not redeployed; {ok:true,store:null} = live
  // but no match). Uses the prod env secret server-side; never returned to caller.
  let raw: unknown = null;
  const WALLET_URL = (process.env.RANI_WALLET_URL || "").replace(/\/$/, "");
  const OPS = process.env.RANI_OPS_SECRET || "";
  if (WALLET_URL && OPS) {
    try {
      const r = await fetch(WALLET_URL, {
        method: "POST",
        headers: { authorization: `Bearer ${OPS}`, "content-type": "application/json" },
        body: JSON.stringify({ store: "", action: "resolve_store", email }),
        cache: "no-store",
      });
      raw = { status: r.status, body: await r.json().catch(() => null) };
    } catch (e) {
      raw = { error: String(e) };
    }
  }

  return NextResponse.json({
    sharedWalletConfigured: sharedWalletConfigured(),
    email: email || null,
    store,
    raw,
  });
}
