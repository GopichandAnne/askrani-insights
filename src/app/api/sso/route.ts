import { NextResponse } from "next/server";
import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";
import { createServiceClient } from "@/lib/supabase/server";
import { authCookieName } from "@/lib/supabase/cookie-name";
import { ensureOrgForUser } from "@/lib/auth";
import { verifyInboundToken } from "@/lib/sso";

export const dynamic = "force-dynamic";

/**
 * SSO landing for the embedded Insights panel. The Ask Rani host loads this route
 * inside its iframe with a short-lived signed token (?token=…). We verify it,
 * provision/find the matching Insights user + org, start a session, and redirect
 * into the app. Because it runs third-party in an iframe, session cookies are set
 * SameSite=None; Secure. Designed to be idempotent + fast so the host can safely
 * re-issue a token on every panel load (resilient to third-party-cookie blocking).
 */
export async function GET(req: Request) {
  const url = new URL(req.url);
  const token = url.searchParams.get("token") ?? "";
  const { claims, reason } = verifyInboundToken(token);
  if (!claims) {
    // Don't leak detail to the user; the reason is for our own logs.
    console.warn(`[sso] rejected: ${reason}`);
    return NextResponse.redirect(new URL(`/login?sso=${reason ?? "invalid"}`, url.origin));
  }

  try {
    const admin = createServiceClient();
    // generateLink creates the auth user on the fly if they're new, and returns
    // a one-time email OTP we immediately exchange for a session (no email sent).
    const link = await admin.auth.admin.generateLink({ type: "magiclink", email: claims.email });
    if (link.error || !link.data?.properties?.email_otp) {
      console.error("[sso] generateLink failed", link.error?.message);
      return NextResponse.redirect(new URL("/login?sso=provision_failed", url.origin));
    }

    // Cookie-writing client. When Insights is opened in its own tab (the default)
    // the session is first-party, so a strict SameSite=Lax cookie is best. Only
    // when embedded (EMBED_ORIGIN set — the host iframes us, a third-party context)
    // do we need SameSite=None; Secure for the cookie to survive.
    const embedded = !!process.env.EMBED_ORIGIN;
    const cookieStore = await cookies();
    const supabase = createServerClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
      {
        cookieOptions: {
          ...(embedded ? { sameSite: "none" as const, secure: true, path: "/" } : { sameSite: "lax" as const, path: "/" }),
          ...(authCookieName() ? { name: authCookieName() } : {}),
        },
        cookies: {
          getAll: () => cookieStore.getAll(),
          setAll: (toSet: { name: string; value: string; options?: Record<string, unknown> }[]) => {
            try { toSet.forEach(({ name, value, options }) => cookieStore.set(name, value, options as any)); } catch { /* RSC */ }
          },
        },
      },
    );

    const { data, error } = await supabase.auth.verifyOtp({
      type: "email",
      email: claims.email,
      token: link.data.properties.email_otp,
    });
    if (error || !data?.user) {
      console.error("[sso] verifyOtp failed", error?.message);
      return NextResponse.redirect(new URL("/login?sso=session_failed", url.origin));
    }

    // Ensure the tenant exists (idempotent) so they land straight in the app.
    await ensureOrgForUser(data.user.id, claims.email);

    // Honor a same-origin return path (from the direct "Sign in with Ask Rani"
    // flow); default to the app home. Reject anything not a local path.
    const ret = url.searchParams.get("return");
    const dest = ret && ret.startsWith("/") && !ret.startsWith("//") ? ret : "/";
    return NextResponse.redirect(new URL(dest, url.origin));
  } catch (e) {
    console.error("[sso] error", (e as Error).message);
    return NextResponse.redirect(new URL("/login?sso=error", url.origin));
  }
}
