import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { getSalesforceAuthorizationUrl } from "@/lib/salesforce/client";
import { getProfileByUserId } from "@/lib/auth/profile";
import { isAdminProfile } from "@/lib/auth/roles";
import { isAdminEmail } from "@/lib/auth/admin";
import { mintOAuthNonce, PROD_STATE_COOKIE, PROD_STATE_PREFIX } from "@/lib/salesforce/oauth-state";

/**
 * Kick off the Salesforce OAuth dance.
 *
 * GATED: admins only — the login it starts replaces the org-wide credential
 * every snapshot read and Tomco write-back uses. The same gate as the
 * Integrations page that links here; the callback repeats it.
 *
 * Flow:
 *   1. User visits /api/auth/salesforce/login (must be signed in via Google SSO)
 *   2. We build the SF authorize URL w/ our callback URL
 *   3. Redirect user to Salesforce
 *   4. User signs into Salesforce as the service-account user
 *   5. SF redirects back to /api/auth/salesforce/callback w/ auth code
 *   6. Callback exchanges code for tokens + stores refresh_token
 */
export async function GET(request: Request) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    const loginUrl = new URL("/", request.url);
    loginUrl.searchParams.set("error", "must_be_signed_in");
    return NextResponse.redirect(loginUrl);
  }
  const profile = await getProfileByUserId(user.id);
  if (!isAdminProfile(profile, isAdminEmail(user.email))) {
    return NextResponse.redirect(new URL("/dashboard", request.url));
  }

  // The callback URL must match what's registered in the Connected App.
  // Derive from the request origin so it works for both localhost dev + the live URL.
  const { origin } = new URL(request.url);
  const redirectUri = `${origin}/api/auth/salesforce/callback`;

  // The nonce rides both the httpOnly cookie and `state`; the callback stores
  // nothing unless they agree, so a ?code= minted anywhere else is refused.
  const nonce = mintOAuthNonce();
  const res = NextResponse.redirect(getSalesforceAuthorizationUrl(redirectUri, `${PROD_STATE_PREFIX}${nonce}`));
  res.cookies.set(PROD_STATE_COOKIE, nonce, { httpOnly: true, sameSite: "lax", secure: origin.startsWith("https:"), path: "/", maxAge: 600 });
  return res;
}
