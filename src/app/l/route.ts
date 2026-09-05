import { NextResponse } from "next/server";
import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";
import { createServiceClient } from "@/lib/supabase/server";
import { authCookieName } from "@/lib/supabase/cookie-name";
import { ensureOrgForUser } from "@/lib/auth";
import { verifyBriefToken } from "@/lib/brieflink";
import { ACTIVE_WS_COOKIE } from "@/lib/workspace";

export const dynamic = "force-dynamic";

/**
 * Brief deep-link landing. A brief's link (/l?token=…) lands here; we verify the
 * signed token, start the owner's session (generateLink → verifyOtp, no email
 * sent — same mechanism as SSO), pin the workspace the token names, and redirect
 * to the exact item — so tapping a brief opens straight onto the thing that
 * matters, already signed in. RLS still guards every read, so pinning a workspace
 * the user can't see simply falls back; the token only shortcuts the login.
 */
export async function GET(req: Request) {
  const url = new URL(req.url);
  const token = url.searchParams.get("token") ?? "";
  const { claims, reason } = verifyBriefToken(token);
  if (!claims) {
    console.warn(`[brieflink] rejected: ${reason}`);
    return NextResponse.redirect(new URL(`/login?link=${reason ?? "invalid"}`, url.origin));
  }

  try {
    const admin = createServiceClient();
    const link = await admin.auth.admin.generateLink({ type: "magiclink", email: claims.email });
    if (link.error || !link.data?.properties?.email_otp) {
      console.error("[brieflink] generateLink failed", link.error?.message);
      return NextResponse.redirect(new URL("/login?link=provision_failed", url.origin));
    }

    const cookieStore = await cookies();
    const supabase = createServerClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
      {
        cookieOptions: { sameSite: "lax" as const, path: "/", ...(authCookieName() ? { name: authCookieName() } : {}) },
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
      console.error("[brieflink] verifyOtp failed", error?.message);
      return NextResponse.redirect(new URL("/login?link=session_failed", url.origin));
    }

    await ensureOrgForUser(data.user.id, claims.email);

    // Pin the workspace the token names (RLS still guards the reads).
    try {
      cookieStore.set(ACTIVE_WS_COOKIE, claims.ws, { httpOnly: true, sameSite: "lax", path: "/", maxAge: 60 * 60 * 24 * 365 });
    } catch { /* RSC */ }

    return NextResponse.redirect(new URL(claims.to, url.origin));
  } catch (e) {
    console.error("[brieflink] error", (e as Error).message);
    return NextResponse.redirect(new URL("/login?link=error", url.origin));
  }
}
