"use client";

import { useState, type ChangeEvent } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { RaniMark } from "@/components/RaniSpinner";

/**
 * Passwordless auth — phone (SMS OTP via Twilio) or email (magic link). Registration
 * collects name, email, phone and business/org name; the phone becomes the account's
 * identity AND (elsewhere) the WhatsApp assistant's, so owners are recognized when
 * they message Rani. Sign-in accepts either phone or email — whichever's quicker.
 */

const normPhone = (s: string) => {
  const digits = s.replace(/\D/g, "");
  return digits ? `+${digits}` : "";
};

// Country dial codes for the phone field — defaults to US (+1) so most owners
// never type a country code. Covers the US + the main diaspora/expansion markets;
// power users can still paste a full "+.." number and it's used as-is.
const DIAL_CODES = [
  { dial: "+1", flag: "🇺🇸", name: "US / Canada" },
  { dial: "+44", flag: "🇬🇧", name: "UK" },
  { dial: "+91", flag: "🇮🇳", name: "India" },
  { dial: "+61", flag: "🇦🇺", name: "Australia" },
  { dial: "+971", flag: "🇦🇪", name: "UAE" },
  { dial: "+52", flag: "🇲🇽", name: "Mexico" },
  { dial: "+63", flag: "🇵🇭", name: "Philippines" },
  { dial: "+65", flag: "🇸🇬", name: "Singapore" },
  { dial: "+49", flag: "🇩🇪", name: "Germany" },
  { dial: "+33", flag: "🇫🇷", name: "France" },
  { dial: "+81", flag: "🇯🇵", name: "Japan" },
  { dial: "+55", flag: "🇧🇷", name: "Brazil" },
];

// Base URL of the Ask Rani (Rani) app for the unified "Sign in with Ask Rani" SSO.
const RANI_APP = (process.env.NEXT_PUBLIC_RANI_APP_URL || "https://app.askrani.ai").replace(/\/$/, "");

// Direct Google sign-in on Insights. Shown only once Google is enabled as an
// OAuth provider on the Insights Supabase project (flip the flag then), so we
// never render a button that errors. The SAME Google account signs into the Rani
// app too, so the shared email is the identity key that ties both under one account.
const GOOGLE_AUTH = process.env.NEXT_PUBLIC_INSIGHTS_GOOGLE_AUTH === "1";

function GoogleIcon() {
  return (
    <svg viewBox="0 0 24 24" width="17" height="17" aria-hidden="true">
      <path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 0 1-2.2 3.32v2.76h3.56c2.08-1.92 3.28-4.74 3.28-8.09Z" />
      <path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.56-2.76c-.98.66-2.23 1.06-3.72 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84A11 11 0 0 0 12 23Z" />
      <path fill="#FBBC05" d="M5.84 14.09a6.6 6.6 0 0 1 0-4.18V7.07H2.18a11 11 0 0 0 0 9.86l3.66-2.84Z" />
      <path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1A11 11 0 0 0 2.18 7.07l3.66 2.84C6.71 7.31 9.14 5.38 12 5.38Z" />
    </svg>
  );
}

type Tab = "signin" | "register";
type Method = "phone" | "email";

export function LoginClient() {
  const supabase = createClient();
  const router = useRouter();

  const [tab, setTab] = useState<Tab>("signin");
  const [method, setMethod] = useState<Method>("phone");
  const [step, setStep] = useState<"form" | "code">("form");
  const [dial, setDial] = useState("+1");
  const [f, setF] = useState({ name: "", business: "", email: "", phone: "" });
  const [code, setCode] = useState("");
  const [pendingPhone, setPendingPhone] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok?: boolean; text: string } | null>(null);

  const set = (k: keyof typeof f) => (e: ChangeEvent<HTMLInputElement>) => setF((s) => ({ ...s, [k]: e.target.value }));
  const origin = typeof window !== "undefined" ? window.location.origin : "";
  const switchTab = (t: Tab) => { setTab(t); setStep("form"); setMsg(null); if (t === "register") setMethod("phone"); };

  async function signInWithGoogle() {
    if (busy) return;
    setBusy(true); setMsg(null);
    try {
      const { error } = await supabase.auth.signInWithOAuth({
        provider: "google",
        // Reuse the existing OAuth callback; select_account so people with more
        // than one Google can pick the one they use for Ask Rani.
        options: { redirectTo: `${origin}/auth/callback?next=/`, queryParams: { prompt: "select_account" } },
      });
      if (error) throw error;
      // On success the browser redirects to Google — keep the spinner up.
    } catch (e) {
      setMsg({ text: (e as Error)?.message || "Couldn't start Google sign-in." });
      setBusy(false);
    }
  }

  async function submit() {
    if (busy) return;
    setBusy(true); setMsg(null);
    try {
      const useEmail = method === "email" && tab === "signin";
      if (useEmail) {
        const email = f.email.trim();
        if (!email) { setMsg({ text: "Enter your email." }); return; }
        const { error } = await supabase.auth.signInWithOtp({ email, options: { emailRedirectTo: `${origin}/auth/callback?next=/`, shouldCreateUser: false } });
        if (error) throw error;
        setMsg({ ok: true, text: `Check your inbox — we emailed a sign-in link to ${email}.` });
        return;
      }
      // phone SMS OTP (both sign-in and register) — combine the selected dial code
      // with the local number; a pasted full "+.." number is used verbatim.
      const raw = f.phone.trim();
      const nat = raw.replace(/\D/g, "");
      const phone = raw.startsWith("+") ? normPhone(raw) : (nat ? `${dial}${nat}` : "");
      if (phone.replace(/\D/g, "").length < 7) { setMsg({ text: "Enter your phone number, e.g. 512 555 0142." }); return; }
      if (tab === "register" && (!f.name.trim() || !f.email.trim())) { setMsg({ text: "Please add your name and email too." }); return; }
      const data = tab === "register"
        ? { full_name: f.name.trim(), business_name: f.business.trim(), signup_email: f.email.trim() }
        : undefined;
      const { error } = await supabase.auth.signInWithOtp({ phone, options: { channel: "sms", shouldCreateUser: tab === "register", data } });
      if (error) throw error;
      setPendingPhone(phone);
      setStep("code");
      setMsg({ ok: true, text: `We texted a 6-digit code to ${phone}.` });
    } catch (e) {
      setMsg({ text: (e as Error)?.message || "Couldn't send — please try again." });
    } finally {
      setBusy(false);
    }
  }

  async function verify() {
    if (busy) return;
    setBusy(true); setMsg(null);
    try {
      const { error } = await supabase.auth.verifyOtp({ phone: pendingPhone, token: code.trim(), type: "sms" });
      if (error) throw error;
      // Route to /welcome to finish first-run setup (bootstrap org + trial credits,
      // confirm name/business, link the phone). Registered users land there with
      // their details pre-filled; the page forwards them on once profile_complete
      // is set, and the middleware gate catches any first-time sign-in too.
      router.push("/welcome");
      router.refresh();
    } catch (e) {
      setMsg({ text: (e as Error)?.message || "That code didn't work — check it and try again." });
    } finally {
      setBusy(false);
    }
  }

  const inputCls = "w-full rounded-xl border border-line bg-white/80 px-3.5 py-3 text-sm outline-none focus:border-brand";

  return (
    <div className="flex min-h-[calc(100vh-8rem)] items-center justify-center px-6 py-10">
      <div className="w-full max-w-md animate-fade-up">
        <div className="glass-strong overflow-hidden rounded-3xl shadow-glass">
          <div className="relative overflow-hidden bg-brand-hero px-8 py-9 text-center text-white">
            <div className="pointer-events-none absolute -right-8 -top-10 h-32 w-32 rounded-full bg-white/15 blur-2xl" aria-hidden />
            <div className="relative flex flex-col items-center gap-3">
              <RaniMark size={52} />
              <div>
                <div className="font-display text-2xl font-extrabold italic">Ask Rani Insights</div>
                <p className="mt-1 text-sm text-white/85">Know what your local market is doing, and what to do next.</p>
              </div>
            </div>
          </div>

          <div className="p-7">
            {/* Unified sign-in: one Ask Rani account across Rani + Insights. */}
            <a
              href={`${RANI_APP}/api/insights/sso/start?return=/`}
              className="mb-4 flex w-full items-center justify-center gap-2 rounded-xl border border-line bg-white/80 py-3 text-sm font-semibold text-brand-deep transition-all hover:shadow-glow"
            >
              <RaniMark size={18} /> Continue with Ask Rani
            </a>
            {GOOGLE_AUTH && (
              <button
                type="button"
                onClick={signInWithGoogle}
                disabled={busy}
                className="mb-4 flex w-full items-center justify-center gap-2 rounded-xl border border-line bg-white/80 py-3 text-sm font-semibold text-ink transition-all hover:shadow-glow disabled:opacity-60"
              >
                <GoogleIcon /> Continue with Google
              </button>
            )}
            <div className="mb-4 flex items-center gap-3 text-xs text-ink-faint">
              <span className="h-px flex-1 bg-line" /> or <span className="h-px flex-1 bg-line" />
            </div>

            {/* tabs */}
            <div className="mb-5 flex rounded-2xl bg-surface-sunken p-1 text-sm font-semibold">
              {(["signin", "register"] as Tab[]).map((t) => (
                <button key={t} onClick={() => switchTab(t)} className={`flex-1 rounded-xl py-2 transition-colors ${tab === t ? "bg-white text-brand-deep shadow-sm" : "text-ink-soft"}`}>
                  {t === "signin" ? "Sign in" : "Create account"}
                </button>
              ))}
            </div>

            {step === "code" ? (
              <div className="space-y-3">
                <p className="text-sm text-ink-soft">Enter the 6-digit code we sent to <b className="text-ink">{pendingPhone}</b>.</p>
                <input value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, "").slice(0, 6))} inputMode="numeric" placeholder="••••••" className={`${inputCls} text-center text-xl tracking-[0.4em]`} />
                <button onClick={verify} disabled={busy || code.length < 4} className="btn btn-primary w-full py-3 disabled:opacity-60">{busy ? "Verifying…" : "Verify & continue"}</button>
                <button onClick={() => { setStep("form"); setCode(""); setMsg(null); }} className="w-full text-center text-xs text-ink-faint hover:text-brand">← use a different number</button>
              </div>
            ) : (
              <div className="space-y-3">
                {tab === "register" && (
                  <>
                    <input value={f.name} onChange={set("name")} placeholder="Your name" className={inputCls} />
                    <input value={f.business} onChange={set("business")} placeholder="Business / organization name" className={inputCls} />
                    <input value={f.email} onChange={set("email")} type="email" placeholder="you@business.com" className={inputCls} />
                  </>
                )}

                {tab === "signin" && (
                  <div className="flex rounded-xl bg-surface-sunken p-1 text-xs font-semibold">
                    {(["phone", "email"] as Method[]).map((m) => (
                      <button key={m} onClick={() => { setMethod(m); setMsg(null); }} className={`flex-1 rounded-lg py-1.5 transition-colors ${method === m ? "bg-white text-brand-deep shadow-sm" : "text-ink-soft"}`}>
                        {m === "phone" ? "📱 Phone" : "✉️ Email"}
                      </button>
                    ))}
                  </div>
                )}

                {(tab === "register" || method === "phone")
                  ? (
                    <div className="flex gap-2">
                      <select value={dial} onChange={(e) => setDial(e.target.value)} aria-label="Country code" className="w-24 shrink-0 rounded-xl border border-line bg-white/80 px-2 py-3 text-sm outline-none focus:border-brand">
                        {DIAL_CODES.map((c) => <option key={c.name} value={c.dial}>{c.flag} {c.dial}</option>)}
                      </select>
                      <input value={f.phone} onChange={set("phone")} type="tel" inputMode="tel" placeholder="512 555 0142" className={`${inputCls} min-w-0 flex-1`} />
                    </div>
                  )
                  : <input value={f.email} onChange={set("email")} type="email" placeholder="you@business.com" className={inputCls} />}

                <button onClick={submit} disabled={busy} className="btn btn-primary w-full py-3 disabled:opacity-60">
                  {busy ? "Sending…" : tab === "register" ? "Create account" : method === "phone" ? "Text me a code" : "Email me a sign-in link"}
                </button>
                <p className="text-center text-[11px] text-ink-faint">No passwords — {tab === "register" ? "we'll text a code to confirm your number" : method === "phone" ? "we'll text you a one-time code" : "we'll email you a one-time link"}.</p>
              </div>
            )}

            {msg && (
              <p className={`mt-3 rounded-xl border p-2.5 text-sm ${msg.ok ? "border-trust-direct/30 bg-trust-direct/5 text-trust-direct" : "border-trust-low/30 bg-trust-low/5 text-trust-low"}`}>{msg.text}</p>
            )}
          </div>
        </div>
        <p className="mt-4 text-center text-xs text-ink-faint">Public market analysis needs no account — sign in only to save it.</p>
      </div>
    </div>
  );
}
