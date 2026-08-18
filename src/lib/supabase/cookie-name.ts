/**
 * Pin the Supabase auth-cookie name so every client agrees on it.
 *
 * supabase-js derives the cookie name from whatever URL a client is built with:
 * `sb-<url-host-first-label>-auth-token`. Our browser client dials the PUBLIC
 * custom domain (e.g. insights-api.askrani.ai → `sb-insights-api-auth-token`)
 * while server clients dial a faster INTERNAL *.supabase.co host (e.g.
 * lmyy…supabase.co → `sb-lmyy…-auth-token`). Those names DIVERGE, so a session
 * cookie written by one side is invisible to the other: a client-side sign-in
 * (phone OTP) writes the browser-named cookie, the server can't find it, and
 * every server render sees "logged out" → bounces back to /login.
 *
 * Fix: derive one name from the PUBLIC url (which both browser and server can
 * read from NEXT_PUBLIC_SUPABASE_URL) and pass it to every createClient via
 * `cookieOptions.name`, regardless of which host that client actually connects to.
 */
export function authCookieName(): string | undefined {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  if (!url) return undefined;
  try {
    return `sb-${new URL(url).hostname.split(".")[0]}-auth-token`;
  } catch {
    return undefined;
  }
}
