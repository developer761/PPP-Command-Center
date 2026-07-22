"use client";

import { useState } from "react";
import { createClient } from "@/lib/supabase/client";

/**
 * Email + password sign-in for admin-provisioned accounts.
 *
 * Shown beneath the Google button on the login page. Google-SSO staff keep
 * using Google; users an admin created in Settings → Access sign in here with
 * the email + password they were given. On success we route to the dashboard;
 * a deactivated account still authenticates with Supabase but is bounced by
 * the dashboard layout's is_active gate (→ /?error=access_revoked).
 */
export default function EmailPasswordSignIn({
  redirectTo = "/dashboard",
}: {
  redirectTo?: string;
}) {
  const [open, setOpen] = useState(false);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [showPw, setShowPw] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (pending) return;
    setPending(true);
    setError(null);
    try {
      const supabase = createClient();
      const { error: signInError } = await supabase.auth.signInWithPassword({
        email: email.trim().toLowerCase(),
        password,
      });
      if (signInError) {
        setError("Incorrect email or password.");
        setPending(false);
        return;
      }
      // Full navigation so the server layout re-reads the fresh session cookie.
      window.location.href = redirectTo;
    } catch {
      setError("Something went wrong. Please try again.");
      setPending(false);
    }
  };

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="mt-3 w-full text-center text-xs sm:text-sm font-medium text-ppp-charcoal-500 hover:text-ppp-charcoal-700 transition-colors min-h-[44px]"
      >
        Sign in with email &amp; password
      </button>
    );
  }

  return (
    <form onSubmit={submit} className="mt-4 space-y-3 animate-fade-up">
      {error && (
        <div className="rounded-lg border border-rose-200 bg-rose-50 text-rose-700 text-xs sm:text-sm px-3 py-2.5">
          {error}
        </div>
      )}
      <div>
        <label htmlFor="ep-email" className="block text-xs font-semibold text-ppp-charcoal-600 mb-1">
          Email
        </label>
        <input
          id="ep-email"
          type="email"
          required
          autoComplete="username"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          className="w-full rounded-lg border border-ppp-charcoal-200 px-3 py-2.5 text-sm focus:border-ppp-blue focus:ring-1 focus:ring-ppp-blue outline-none min-h-[44px]"
        />
      </div>
      <div>
        <label htmlFor="ep-password" className="block text-xs font-semibold text-ppp-charcoal-600 mb-1">
          Password
        </label>
        <div className="relative">
          <input
            id="ep-password"
            type={showPw ? "text" : "password"}
            required
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className="w-full rounded-lg border border-ppp-charcoal-200 pl-3 pr-10 py-2.5 text-sm focus:border-ppp-blue focus:ring-1 focus:ring-ppp-blue outline-none min-h-[44px]"
          />
          <button
            type="button"
            onClick={() => setShowPw((v) => !v)}
            className="absolute right-2 top-1/2 -translate-y-1/2 text-ppp-charcoal-400 hover:text-ppp-charcoal-600 p-1"
            aria-label={showPw ? "Hide password" : "Show password"}
          >
            {showPw ? (
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="M9.9 4.24A9.1 9.1 0 0 1 12 4c6.5 0 10 7 10 7a13.2 13.2 0 0 1-1.67 2.68 M6.6 6.6A13.3 13.3 0 0 0 2 11s3.5 7 10 7a9 9 0 0 0 3.4-.66 M14.1 14.1a3 3 0 1 1-4.2-4.2 M1 1l22 22" /></svg>
            ) : (
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7Z" /><circle cx="12" cy="12" r="3" /></svg>
            )}
          </button>
        </div>
      </div>
      <button
        type="submit"
        disabled={pending || !email || !password}
        className="w-full inline-flex items-center justify-center gap-2 bg-ppp-navy text-white font-medium py-3 px-4 rounded-lg hover:bg-ppp-navy-600 active:bg-ppp-navy-700 transition-colors disabled:opacity-60 disabled:cursor-not-allowed min-h-[44px]"
      >
        {pending ? "Signing in…" : "Sign in"}
      </button>
      <button
        type="button"
        onClick={() => { setOpen(false); setError(null); }}
        className="w-full text-center text-xs text-ppp-charcoal-400 hover:text-ppp-charcoal-600 min-h-[40px]"
      >
        Back to Google sign-in
      </button>
    </form>
  );
}
