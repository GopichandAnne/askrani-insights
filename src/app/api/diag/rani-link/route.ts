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
  return NextResponse.json({
    sharedWalletConfigured: sharedWalletConfigured(),
    email: email || null,
    store,
  });
}
