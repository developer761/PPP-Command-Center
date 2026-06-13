"use client";

import { useState } from "react";
import { createClient } from "@/lib/supabase/client";

type Props = {
  redirectTo?: string;
};

// Default destination changed 2026-06-12 from /dashboard → /choose-platform
// so multi-platform users see the picker. Single-access users auto-skip the
// picker (the page redirects them to their only platform), so this doesn't
// add friction for anyone — it just unblocks multi-platform users who
// previously got auto-routed to Command Center.
export default function SignInButton({ redirectTo = "/choose-platform" }: Props) {
  const [pending, setPending] = useState(false);

  const onClick = async () => {
    setPending(true);
    const supabase = createClient();
    const origin = window.location.origin;

    const { error } = await supabase.auth.signInWithOAuth({
      provider: "google",
      options: {
        redirectTo: `${origin}/auth/callback?next=${encodeURIComponent(redirectTo)}`,
        queryParams: {
          // No `hd` hint — PPP staff use both @precisionpaintingplus.net and
          // @precisionpaintingplus.com workspaces, plus a small admin allow-list
          // (e.g., Karan's personal gmail). Domain enforcement happens server-side
          // in /auth/callback via isAllowedToSignIn().
          prompt: "select_account",
        },
      },
    });

    if (error) {
      setPending(false);
      window.location.href = `/?error=oauth_failed`;
    }
    // On success, the browser redirects to Google — no further state to manage.
  };

  return (
    <button
      type="button"
      onClick={onClick}
      disabled={pending}
      className="w-full inline-flex items-center justify-center gap-3 bg-ppp-blue text-white font-medium py-3 px-4 rounded-lg hover:bg-ppp-blue-600 active:bg-ppp-blue-700 transition-colors shadow-sm shadow-ppp-blue/30 disabled:opacity-60 disabled:cursor-not-allowed"
    >
      {pending ? (
        <>
          <Spinner />
          Redirecting to Google…
        </>
      ) : (
        <>
          <GoogleIcon />
          Sign in with Google
        </>
      )}
    </button>
  );
}

function GoogleIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden>
      <path
        d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"
        fill="#4285F4"
      />
      <path
        d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"
        fill="#34A853"
      />
      <path
        d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"
        fill="#FBBC05"
      />
      <path
        d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"
        fill="#EA4335"
      />
    </svg>
  );
}

function Spinner() {
  return (
    <svg
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="none"
      className="animate-spin"
      aria-hidden
    >
      <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" opacity="0.25" />
      <path d="M22 12a10 10 0 0 1-10 10" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
    </svg>
  );
}
