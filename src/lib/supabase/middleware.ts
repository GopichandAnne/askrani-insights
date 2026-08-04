import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";

/**
 * Refreshes the Supabase auth session on every request and forwards the
 * (possibly rotated) auth cookies. No-ops when Supabase env is absent so the
 * app still runs pre-configuration.
 */
export async function updateSession(request: NextRequest) {
  let response = NextResponse.next({ request });

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anon = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !anon) return response;

  // When Insights runs embedded in the Ask Rani host iframe (EMBED_ORIGIN set),
  // its auth cookies are third-party, so the rotated session cookie must be
  // SameSite=None; Secure or the browser drops it on the next request.
  const embedded = !!process.env.EMBED_ORIGIN;
  const embedCookie = embedded ? { sameSite: "none" as const, secure: true } : {};

  const supabase = createServerClient(url, anon, {
    ...(embedded ? { cookieOptions: { sameSite: "none" as const, secure: true, path: "/" } } : {}),
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
  await supabase.auth.getUser();
  return response;
}
