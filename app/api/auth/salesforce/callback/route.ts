import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import {
  exchangeCodeForTokens,
  storeSalesforceCredentials,
} from "@/lib/salesforce/client";
import { isAdminEmail } from "@/lib/auth/admin";
import { getProfileByUserId } from "@/lib/auth/profile";
import { isAdminProfile } from "@/lib/auth/roles";
import { oauthStateMatches, PROD_STATE_COOKIE, PROD_STATE_PREFIX, readCookie } from "@/lib/salesforce/oauth-state";
import { finishSandboxSignIn, SANDBOX_STATE_PREFIX } from "@/lib/salesforce/sandbox-callback";

/**
 * Receive the OAuth callback from Salesforce, exchange the auth code for tokens,
 * and persist the refresh_token + instance_url for future API calls.
 *
 * On success → redirect to /dashboard/integrations w/ a success banner.
 * On failure → redirect to /dashboard/integrations w/ an error banner.
 *
 * Stores nothing unless the requester is an ADMIN (the gate on the
 * Integrations page and the login route) and `state` matches the nonce cookie
 * the login route set — otherwise any PPP-domain session, or a crafted
 * ?code= link opened by one, could replace the org-wide Salesforce credential.
 */
export async function GET(request: Request) {
  const { searchParams, origin } = new URL(request.url);

  // A PAYMENTS sandbox sign-in returns here too (the sandbox's copy of the
  // Connected App only lists production's callback URLs). Hand it off before
  // anything below can store it as the production login.
  if (searchParams.get("state")?.startsWith(SANDBOX_STATE_PREFIX)) {
    return finishSandboxSignIn(request, `${origin}/api/auth/salesforce/callback`);
  }

  const code = searchParams.get("code");
  const errorParam = searchParams.get("error");
  const fail = (reason: string) => {
    const res = NextResponse.redirect(`${origin}/dashboard/integrations?sf_error=${encodeURIComponent(reason)}`);
    res.cookies.delete(PROD_STATE_COOKIE);
    return res;
  };

  // Salesforce sends ?error=... when the user denies authorization.
  if (errorParam) return fail(errorParam);
  if (!code) return fail("no_code");

  // Confirm the requester is a signed-in ADMIN before storing tokens.
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user || !user.email) {
    return NextResponse.redirect(`${origin}/?error=must_be_signed_in`);
  }
  const profile = await getProfileByUserId(user.id);
  if (!isAdminProfile(profile, isAdminEmail(user.email))) {
    return NextResponse.redirect(`${origin}/dashboard`);
  }

  // The sign-in must have started here, in this browser.
  const cookieNonce = readCookie(request.headers.get("cookie"), PROD_STATE_COOKIE);
  if (!oauthStateMatches(searchParams.get("state"), PROD_STATE_PREFIX, cookieNonce)) {
    return fail("state_mismatch");
  }

  const redirectUri = `${origin}/api/auth/salesforce/callback`;

  try {
    const tokens = await exchangeCodeForTokens(code, redirectUri);
    await storeSalesforceCredentials({
      refreshToken: tokens.refresh_token,
      instanceUrl: tokens.instance_url,
      storedBy: user.email,
    });
  } catch (err) {
    // Log the real error server-side; surface only a generic reason code to
    // the URL so we don't leak jsforce stack traces / internal endpoints to
    // anyone watching the browser history.
    console.error("[sf-callback] token exchange failed:", err);
    return fail("connection_failed");
  }

  const res = NextResponse.redirect(`${origin}/dashboard/integrations?sf_connected=1`);
  res.cookies.delete(PROD_STATE_COOKIE);
  return res;
}
