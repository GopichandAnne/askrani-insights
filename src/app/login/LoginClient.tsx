"use client";

import { useActionState } from "react";
import { signIn, signUp, type AuthState } from "./actions";

const initial: AuthState = {};

export function LoginClient() {
  const [signInState, signInAction, signingIn] = useActionState(signIn, initial);
  const [signUpState, signUpAction, signingUp] = useActionState(signUp, initial);
  const state = signInState.error || signInState.notice ? signInState : signUpState;

  return (
    <div className="mx-auto max-w-sm space-y-4">
      <div className="rounded-xl border border-line bg-surface p-6">
        <h1 className="text-lg font-semibold">Sign in</h1>
        <p className="mt-1 text-sm text-ink-soft">
          Sign in to save a workspace and keep your market intelligence.
        </p>

        <form className="mt-4 space-y-3">
          <input
            name="email"
            type="email"
            required
            placeholder="you@business.com"
            className="w-full rounded-lg border border-line px-3 py-2 text-sm"
          />
          <input
            name="password"
            type="password"
            required
            placeholder="Password"
            className="w-full rounded-lg border border-line px-3 py-2 text-sm"
          />
          <div className="flex gap-2">
            <button
              formAction={signInAction}
              disabled={signingIn || signingUp}
              className="flex-1 rounded-lg bg-brand px-4 py-2 text-sm font-medium text-white disabled:opacity-60"
            >
              {signingIn ? "Signing in…" : "Sign in"}
            </button>
            <button
              formAction={signUpAction}
              disabled={signingIn || signingUp}
              className="flex-1 rounded-lg border border-line px-4 py-2 text-sm font-medium disabled:opacity-60"
            >
              {signingUp ? "Creating…" : "Create account"}
            </button>
          </div>
        </form>

        {state.error && (
          <p className="mt-3 rounded-lg border border-trust-low/30 bg-trust-low/5 p-2 text-sm text-trust-low">
            {state.error}
          </p>
        )}
        {state.notice && (
          <p className="mt-3 rounded-lg border border-trust-direct/30 bg-trust-direct/5 p-2 text-sm text-trust-direct">
            {state.notice}
          </p>
        )}
      </div>
      <p className="text-center text-xs text-ink-faint">
        Public market analysis needs no account — sign in only to save it.
      </p>
    </div>
  );
}
