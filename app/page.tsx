import Image from "next/image";
import { redirect } from "next/navigation";
import { PPP_BRAND } from "@/lib/brand";
import SignInButton from "@/components/sign-in-button";
import EmailPasswordSignIn from "@/components/email-password-sign-in";

type SearchParams = Promise<{ error?: string; redirectTo?: string; code?: string }>;

/**
 * Every message names the WAY IN, not just the way it failed.
 *
 * Before the 2026-10-07 rollout none of them did. Of 25 active field reps, 24
 * had no account yet and were expected to create one by signing in with
 * Google — which only works if PPP IT has actually issued them a Google
 * Workspace account on the PPP domain. A rep who has a Salesforce user but no
 * Workspace account signs in with their personal Gmail, lands on
 * `domain_not_allowed`, and reads "sign in with your PPP account" — advice
 * they cannot take, with no mention of the email-and-password box sitting
 * directly underneath the button they just pressed.
 *
 * So each one ends by pointing at the fallback that exists. The dead end was
 * the failure, not the error.
 */
const ERROR_COPY: Record<string, string> = {
  domain_not_allowed:
    "That isn't a Precision Painting Plus account. Use your @precisionpaintingplus.com or @precisionpaintingplus.net address — or, if you don't have a PPP Google account, ask an admin for an email and password and sign in with those below.",
  oauth_failed:
    "Google sign-in didn't complete. Try again — or sign in with an email and password below if an admin has set one up for you.",
  no_code:
    "Google sign-in didn't complete. Try again, or use an email and password below.",
  // Kate 2026-08-31: both cases mean the same thing to the person standing
  // there — nobody active answers to this address — so both say it plainly.
  // The old inactive copy also implied we had found THEIR user and it was
  // switched off, which was wrong when the lookup had actually matched a
  // long-dead record on the other domain.
  no_sf_user:
    "There's no active Salesforce user for this address. Both @precisionpaintingplus.com and @precisionpaintingplus.net were checked. Ask an admin to activate your Salesforce user — they can also give you an email and password to use in the meantime.",
  sf_user_inactive:
    "There's no active Salesforce user for this address. Both @precisionpaintingplus.com and @precisionpaintingplus.net were checked. Ask an admin to activate your Salesforce user — they can also give you an email and password to use in the meantime.",
  access_revoked:
    "This account has been switched off. Contact an admin if that's a mistake — signing in another way won't get you back in until they switch it on again.",
};

export default async function LoginLanding({
  searchParams,
}: {
  searchParams: SearchParams;
}) {
  const sp = await searchParams;
  // A Google sign-in that came back HERE instead of /auth/callback: Supabase
  // falls back to the bare Site URL when the requested return address isn't on
  // its Redirect URLs list (e.g. the `?next=` query not matching). The sign-in
  // is half done — finish it rather than show the login form again, which is
  // what made people click "Sign in with Google" two or three times.
  if (sp.code && /^[\w-]{8,200}$/.test(sp.code)) {
    redirect(`/auth/callback?code=${encodeURIComponent(sp.code)}`);
  }
  const errorMessage = sp.error ? ERROR_COPY[sp.error] ?? null : null;
  // Only honor same-origin relative paths to defeat open-redirect attempts.
  // Default destination is /choose-platform so multi-platform users see the
  // picker. The picker page auto-routes single-access users immediately.
  const rawRedirect = sp.redirectTo || "/choose-platform";
  const redirectTo =
    rawRedirect.startsWith("/") && !rawRedirect.startsWith("//") ? rawRedirect : "/choose-platform";

  return (
    <main className="min-h-screen flex flex-col items-center justify-center px-4 relative overflow-hidden">
      {/* Brand gradient backdrop */}
      <div className="absolute inset-0 -z-10 bg-gradient-to-br from-ppp-blue-50 via-white to-ppp-orange-50" />
      <div className="absolute -top-32 -right-32 -z-10 h-96 w-96 rounded-full bg-ppp-blue/10 blur-3xl" />
      <div className="absolute -bottom-32 -left-32 -z-10 h-96 w-96 rounded-full bg-ppp-orange/10 blur-3xl" />

      <div className="w-full max-w-md bg-white rounded-2xl shadow-xl border border-ppp-charcoal-100 p-6 sm:p-10 animate-fade-up">
        <div className="flex justify-center mb-6 sm:mb-8">
          <Image
            src="/brand/logo.svg"
            alt={PPP_BRAND.name}
            width={240}
            height={80}
            priority
            className="w-48 sm:w-60 h-auto"
          />
        </div>

        <div className="text-center mb-6 sm:mb-8">
          <h1 className="font-condensed text-xl sm:text-2xl font-bold text-ppp-navy tracking-tight uppercase">
            Command Center
          </h1>
          <p className="mt-2 text-xs sm:text-sm text-ppp-charcoal-500">
            Internal operations platform · sign in to continue
          </p>
        </div>

        {errorMessage && (
          <div className="mb-4 rounded-lg border border-ppp-orange-100 bg-ppp-orange-50 text-ppp-orange-700 text-xs sm:text-sm px-3 py-2.5">
            {errorMessage}
          </div>
        )}

        <SignInButton redirectTo={redirectTo} />

        <EmailPasswordSignIn />

        <div className="mt-6 text-center text-[11px] sm:text-xs text-ppp-charcoal-500">
          PPP staff. Sign in with your Google Workspace account, or with an
          email &amp; password provided by an admin.
        </div>
      </div>

      <p className="mt-6 sm:mt-8 text-[11px] sm:text-xs text-ppp-charcoal-500 text-center px-4">
        {PPP_BRAND.name} · {PPP_BRAND.tagline}
      </p>
    </main>
  );
}
