import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { isAdminEmail, isAllowedToSignIn, normalizeEmail } from "@/lib/auth/admin";
import { lookupSfUserByEmail } from "@/lib/auth/sf-user-lookup";
import { upsertProfile } from "@/lib/auth/profile";

/**
 * OAuth callback handler. Supabase redirects here after Google completes
 * the OAuth flow. We:
 *   1. Exchange the authorization code for a session
 *   2. Verify the signed-in user is on .net, .com, or in admin allow-list
 *   3. Look up their Salesforce User (with cross-domain fallback)
 *   4. Block sign-in if inactive in SF (admins exempt)
 *   5. Upsert the profile row (Supabase user × SF user × admin flag)
 *   6. Redirect to the dashboard
 *
 * Error codes surfaced to the landing page:
 *   no_code            — OAuth didn't return a code
 *   oauth_failed       — code exchange failed
 *   domain_not_allowed — email isn't a PPP domain and not in admin list
 *   no_sf_user         — non-admin user without matching SF rep
 *   sf_user_inactive   — SF rep is deactivated
 */
export async function GET(request: Request) {
  const { searchParams, origin } = new URL(request.url);
  const code = searchParams.get("code");

  // Sanitize the `next` redirect — only allow same-origin relative paths.
  const rawNext = searchParams.get("next") ?? "/dashboard";
  const next =
    rawNext.startsWith("/") && !rawNext.startsWith("//") ? rawNext : "/dashboard";

  if (!code) {
    return NextResponse.redirect(`${origin}/?error=no_code`);
  }

  const supabase = await createClient();
  const { error: exchangeError } = await supabase.auth.exchangeCodeForSession(code);

  if (exchangeError) {
    return NextResponse.redirect(`${origin}/?error=oauth_failed`);
  }

  const { data: { user } } = await supabase.auth.getUser();
  const email = normalizeEmail(user?.email);

  // 1. Widen domain check — .net OR .com OR admin allow-list (Karan's gmail).
  if (!user || !isAllowedToSignIn(email)) {
    await supabase.auth.signOut();
    return NextResponse.redirect(`${origin}/?error=domain_not_allowed`);
  }

  const isAdmin = isAdminEmail(email);

  // 2. SF User lookup. Cross-domain fallback handled internally.
  //    If SF is unreachable (e.g., refresh token expired), returns null —
  //    we still let admins in so they can recover from a SF outage.
  const sfUser = await lookupSfUserByEmail(email);

  // 3. Inactive SF user → block, UNLESS they're admin.
  if (sfUser && !sfUser.isActive && !isAdmin) {
    await supabase.auth.signOut();
    return NextResponse.redirect(`${origin}/?error=sf_user_inactive`);
  }

  // 4. No SF match AND not admin → block.
  if (!sfUser && !isAdmin) {
    await supabase.auth.signOut();
    return NextResponse.redirect(`${origin}/?error=no_sf_user`);
  }

  // 5. Sync profile row (idempotent upsert keyed on user_id).
  await upsertProfile({
    user_id: user.id,
    email,
    sf_user_id: sfUser?.id ?? null,
    sf_user_name: sfUser?.name ?? null,
    is_admin: isAdmin,
    is_active: sfUser?.isActive ?? true,
  });

  return NextResponse.redirect(`${origin}${next}`);
}
