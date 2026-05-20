import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import {
  exchangeCodeForTokens,
  storeSalesforceCredentials,
} from "@/lib/salesforce/client";

/**
 * Receive the OAuth callback from Salesforce, exchange the auth code for tokens,
 * and persist the refresh_token + instance_url for future API calls.
 *
 * On success → redirect to /dashboard/integrations w/ a success banner.
 * On failure → redirect to /dashboard/integrations w/ an error banner.
 */
export async function GET(request: Request) {
  const { searchParams, origin } = new URL(request.url);
  const code = searchParams.get("code");
  const errorParam = searchParams.get("error");

  // Salesforce sends ?error=... when the user denies authorization.
  if (errorParam) {
    return NextResponse.redirect(
      `${origin}/dashboard/integrations?sf_error=${encodeURIComponent(errorParam)}`
    );
  }

  if (!code) {
    return NextResponse.redirect(
      `${origin}/dashboard/integrations?sf_error=no_code`
    );
  }

  // Confirm the requester is still a signed-in PPP user before storing tokens.
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user || !user.email?.toLowerCase().endsWith("@precisionpaintingplus.net")) {
    return NextResponse.redirect(`${origin}/?error=domain_not_allowed`);
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
    const reason = err instanceof Error ? err.message : "unknown_error";
    return NextResponse.redirect(
      `${origin}/dashboard/integrations?sf_error=${encodeURIComponent(reason)}`
    );
  }

  return NextResponse.redirect(
    `${origin}/dashboard/integrations?sf_connected=1`
  );
}
