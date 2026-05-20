import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

/**
 * OAuth callback handler. Supabase redirects here after Google completes
 * the OAuth flow. We exchange the authorization code for a session, then
 * redirect to the dashboard (or back to login if anything went wrong).
 */
export async function GET(request: Request) {
  const { searchParams, origin } = new URL(request.url);
  const code = searchParams.get("code");
  const next = searchParams.get("next") ?? "/dashboard";

  if (!code) {
    return NextResponse.redirect(`${origin}/?error=no_code`);
  }

  const supabase = await createClient();
  const { error } = await supabase.auth.exchangeCodeForSession(code);

  if (error) {
    return NextResponse.redirect(`${origin}/?error=oauth_failed`);
  }

  // Verify the signed-in user is on the @precisionpaintingplus.net domain.
  // The OAuth consent screen is "Internal" so this should always pass — this
  // is defense-in-depth in case configuration drifts.
  const { data: { user } } = await supabase.auth.getUser();
  const email = user?.email?.toLowerCase() ?? "";
  if (!email.endsWith("@precisionpaintingplus.net")) {
    await supabase.auth.signOut();
    return NextResponse.redirect(`${origin}/?error=domain_not_allowed`);
  }

  return NextResponse.redirect(`${origin}${next}`);
}
