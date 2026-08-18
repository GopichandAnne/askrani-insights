import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";
import { authCookieName } from "./cookie-name";

/**
 * Refreshes the Supabase auth session on every request and forwards the
 * (possibly rotated) auth cookies. No-ops when Supabase env is absent so the
 * app still runs pre-configuration.
 */
export async function updateSession(request: NextRequest) {
  let response = NextResponse.next({ request });

  // Use the DIRECT *.supabase.co host (SUPABASE_INTERNAL_URL) for this server-side
  // auth call, NOT the custom domain: from Vercel the Cloudflare custom-domain hop
  // adds ~1.5s to getUser() (measured), which was the entire per-navigation cost.
  // Falls back to the public URL when unset. The browser still uses the custom
  // domain; only this server→Supabase call is rerouted.
  const url = process.env.SUPABASE_INTERNAL_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anon = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !anon) return response;

  // When Insights runs embedded in the Ask Rani host iframe (EMBED_ORIGIN set),
  // its auth cookies are third-party, so the rotated session cookie must be
  // SameSite=None; Secure or the browser drops it on the next request.
  const embedded = !!process.env.EMBED_ORIGIN;
  const embedCookie = embedded ? { sameSite: "none" as const, secure: true } : {};

  // Pin the cookie name (PUBLIC-url-derived) so this middleware client — which
  // dials the internal host — reads the same cookie the browser wrote.
  const cookieName = authCookieName();
  const cookieOptions = {
    ...(embedded ? { sameSite: "none" as const, secure: true, path: "/" } : {}),
    ...(cookieName ? { name: cookieName } : {}),
  };

  const supabase = createServerClient(url, anon, {
    ...(Object.keys(cookieOptions).length ? { cookieOptions } : {}),
    cookies: {
      getAll() {
        return request.cookies.getAll();
      },
      setAll(
        cookiesToSet: { name: string; value: string; options?: Record<string, unknown> }[],
      ) {
        cookiesToSet.forEach(({ name, value }) => request.cookies.set(name, value));
        response = NextResponse.next({ request });
        cookiesToSet.forEach(({ name, value, options }) =>
          response.cookies.set(name, value, { ...(options as any), ...embedCookie }),
        );
      },
    },
  });

  // Touch the user so the session refreshes and cookies rotate.
  const { data: { user } } = await supabase.auth.getUser();

  // First-run profile gate: a signed-in user who hasn't finished their profile is
  // routed to /welcome to give name + business — which also bootstraps their org
  // and trial credits (phone sign-in otherwise skips that). Exempt the auth/api
  // surfaces, /welcome itself, and the public Explore front door. Skipped entirely
  // on the embedded (SSO) surface, whose users are provisioned differently.
  if (user && !embedded) {
    const complete = (user.user_metadata as Record<string, unknown> | null)?.profile_complete === true;
    const p = request.nextUrl.pathname;
    const exempt =
      p.startsWith("/welcome") || p.startsWith("/login") || p.startsWith("/auth") ||
      p.startsWith("/api") || p.startsWith("/explore");
    if (!complete && !exempt) {
      const to = request.nextUrl.clone();
      to.pathname = "/welcome";
      to.search = "";
      const redirect = NextResponse.redirect(to);
      response.cookies.getAll().forEach((c) => redirect.cookies.set(c));
      return redirect;
    }
  }

  return response;
}
