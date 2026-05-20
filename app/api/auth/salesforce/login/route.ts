import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { getSalesforceAuthorizationUrl } from "@/lib/salesforce/client";

/**
 * Kick off the Salesforce OAuth dance.
 *
 * GATED: only signed-in PPP users can hit this route (middleware enforces auth +
 * domain). We additionally check here that the user is signed in before bouncing
 * to Salesforce, as belt-and-suspenders.
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

  // The callback URL must match what's registered in the Connected App.
  // Derive from the request origin so it works for both localhost dev + the live URL.
  const { origin } = new URL(request.url);
  const redirectUri = `${origin}/api/auth/salesforce/callback`;

  const authorizeUrl = getSalesforceAuthorizationUrl(redirectUri);
  return NextResponse.redirect(authorizeUrl);
}
