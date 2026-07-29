import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { ensureOrgForUser, isServiceConfigured } from "@/lib/auth";

/**
 * OAuth / magic-link callback: exchange the code for a session, bootstrap the
 * org, then continue. Present for completeness (email+password doesn't use it).
 */
export async function GET(request: Request) {
  const { searchParams, origin } = new URL(request.url);
  const code = searchParams.get("code");
  const next = searchParams.get("next") ?? "/onboarding";

  if (code) {
    const supabase = await createClient();
    const { data, error } = await supabase.auth.exchangeCodeForSession(code);
    if (!error && data.user && isServiceConfigured()) {
      try {
        await ensureOrgForUser(data.user.id, data.user.email);
      } catch {
        /* non-fatal; org bootstraps again on next authed action */
      }
    }
    if (!error) return NextResponse.redirect(`${origin}${next}`);
  }
  return NextResponse.redirect(`${origin}/login`);
}
