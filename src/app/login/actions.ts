"use server";

import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { ensureOrgForUser, isSupabaseConfigured, isServiceConfigured } from "@/lib/auth";

export interface AuthState {
  error?: string;
  notice?: string;
}

export async function signIn(_prev: AuthState, formData: FormData): Promise<AuthState> {
  if (!isSupabaseConfigured()) return { error: "Supabase is not configured (set the env keys)." };
  const email = String(formData.get("email") ?? "").trim();
  const password = String(formData.get("password") ?? "");
  if (!email || !password) return { error: "Email and password are required." };

  const supabase = await createClient();
  const { data, error } = await supabase.auth.signInWithPassword({ email, password });
  if (error) return { error: error.message };

  if (data.user && isServiceConfigured()) {
    try {
      await ensureOrgForUser(data.user.id, data.user.email);
    } catch (e) {
      return { error: `Signed in, but workspace setup failed: ${(e as Error).message}` };
    }
  }
  redirect("/onboarding");
}

export async function signUp(_prev: AuthState, formData: FormData): Promise<AuthState> {
  if (!isSupabaseConfigured()) return { error: "Supabase is not configured (set the env keys)." };
  const email = String(formData.get("email") ?? "").trim();
  const password = String(formData.get("password") ?? "");
  if (!email || password.length < 6)
    return { error: "Enter an email and a password of at least 6 characters." };

  const supabase = await createClient();
  const { data, error } = await supabase.auth.signUp({ email, password });
  if (error) return { error: error.message };

  // If email confirmation is disabled, a session exists immediately.
  if (data.session && data.user && isServiceConfigured()) {
    try {
      await ensureOrgForUser(data.user.id, data.user.email);
    } catch (e) {
      return { error: `Account created, but workspace setup failed: ${(e as Error).message}` };
    }
    redirect("/onboarding");
  }
  return { notice: "Account created. Check your email to confirm, then sign in." };
}
