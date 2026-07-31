"use client";

import { useActionState } from "react";
import { signIn, signUp, type AuthState } from "./actions";
import { RaniMark } from "@/components/RaniSpinner";

const initial: AuthState = {};

export function LoginClient() {
  const [signInState, signInAction, signingIn] = useActionState(signIn, initial);
  const [signUpState, signUpAction, signingUp] = useActionState(signUp, initial);
  const state = signInState.error || signInState.notice ? signInState : signUpState;

  return (
    <div className="flex min-h-[calc(100vh-8rem)] items-center justify-center px-6 py-10">
      <div className="w-full max-w-md animate-fade-up">
        <div className="glass-strong overflow-hidden rounded-3xl shadow-glass">
          {/* branded header */}
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
            <h1 className="text-xl font-bold">Welcome</h1>
            <p className="mt-1 text-sm text-ink-soft">Sign in to save your workspace and keep your market intelligence.</p>

            <form className="mt-5 space-y-3">
              <input name="email" type="email" required placeholder="you@business.com" className="field" />
              <input name="password" type="password" required placeholder="Password" className="field" />
              <div className="flex gap-2 pt-1">
                <button formAction={signInAction} disabled={signingIn || signingUp} className="btn btn-primary flex-1 py-3 disabled:opacity-60">
                  {signingIn ? "Signing in…" : "Sign in"}
                </button>
                <button formAction={signUpAction} disabled={signingIn || signingUp} className="btn btn-secondary flex-1 py-3 disabled:opacity-60">
                  {signingUp ? "Creating…" : "Create account"}
                </button>
              </div>
            </form>

            {state.error && (
              <p className="mt-3 rounded-xl border border-trust-low/30 bg-trust-low/5 p-2.5 text-sm text-trust-low">{state.error}</p>
            )}
            {state.notice && (
              <p className="mt-3 rounded-xl border border-trust-direct/30 bg-trust-direct/5 p-2.5 text-sm text-trust-direct">{state.notice}</p>
            )}
          </div>
        </div>
        <p className="mt-4 text-center text-xs text-ink-faint">
          Public market analysis needs no account — sign in only to save it.
        </p>
      </div>
    </div>
  );
}
