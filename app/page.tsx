import Image from "next/image";
import { PPP_BRAND } from "@/lib/brand";
import SignInButton from "@/components/sign-in-button";
import EmailPasswordSignIn from "@/components/email-password-sign-in";

type SearchParams = Promise<{ error?: string; redirectTo?: string }>;

const ERROR_COPY: Record<string, string> = {
  domain_not_allowed:
    "Your account isn't part of Precision Painting Plus. Sign in with your @precisionpaintingplus.net or @precisionpaintingplus.com account.",
  oauth_failed:
    "Sign-in didn't complete. Please try again — if it keeps failing, contact an admin.",
  no_code:
    "Sign-in didn't complete. Please try again.",
  no_sf_user:
    "We couldn't find a matching Salesforce user for your email. Ask an admin to confirm your Salesforce account is active and your email matches.",
  sf_user_inactive:
    "Your Salesforce user is marked inactive. Contact an admin to reactivate it before signing in.",
  access_revoked:
    "Your account has been deactivated. Contact an admin if you think this is a mistake.",
};

export default async function LoginLanding({
  searchParams,
}: {
  searchParams: SearchParams;
}) {
  const sp = await searchParams;
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
