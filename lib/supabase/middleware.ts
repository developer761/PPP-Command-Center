import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";
import { isAllowedToSignIn } from "@/lib/auth/admin";

/**
 * Runs on every request. Refreshes the user's auth session (rotates expiring
 * tokens), gates protected routes, and enforces the PPP domain allow-list:
 * .net + .com workspaces, plus any email in PPP_ADMIN_EMAILS (Karan's gmail).
 */
export async function updateSession(request: NextRequest) {
  let response = NextResponse.next({ request });

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll();
        },
        setAll(cookiesToSet) {
          cookiesToSet.forEach(({ name, value }) =>
            request.cookies.set(name, value)
          );
          response = NextResponse.next({ request });
          cookiesToSet.forEach(({ name, value, options }) =>
            response.cookies.set(name, value, options)
          );
        },
      },
    }
  );

  const {
    data: { user },
  } = await supabase.auth.getUser();

  const url = request.nextUrl;
  const path = url.pathname;

  // Protect /dashboard/* (Command Center), /commercial/* (New Platform),
  // /choose-platform, and /api/v1/* — require auth + correct domain
  const isProtected =
    path.startsWith("/dashboard") ||
    path.startsWith("/commercial") ||
    path.startsWith("/choose-platform") ||
    path.startsWith("/api/v1");

  if (isProtected) {
    if (!user) {
      const loginUrl = url.clone();
      loginUrl.pathname = "/";
      // Only store the path; never store a full URL or external value. The path is
      // already same-origin since it comes from request.nextUrl.
      loginUrl.searchParams.set("redirectTo", path);
      return NextResponse.redirect(loginUrl);
    }

    // Domain guard — .net + .com workspaces + admin allow-list. Admin-
    // provisioned email+password accounts (Settings → Access) carry a stable
    // `provisioned` marker in their JWT app_metadata, so they're allowed in on
    // any email without a per-request DB read. Their is_active status is still
    // enforced at the dashboard layout (deactivate = lockout).
    const email = user.email?.toLowerCase() ?? "";
    const appMeta = (user.app_metadata ?? {}) as Record<string, unknown>;
    const provisioned = appMeta.provisioned === true;
    if (!isAllowedToSignIn(email) && !provisioned) {
      await supabase.auth.signOut();
      const denyUrl = url.clone();
      denyUrl.pathname = "/";
      denyUrl.searchParams.set("error", "domain_not_allowed");
      return NextResponse.redirect(denyUrl);
    }
  }

  // If a signed-in user hits the login page, send them through the picker.
  // Picker auto-redirects single-access users to their only platform, so a
  // user who only has Command Center never sees the picker — they land on
  // /dashboard immediately. The picker is the canonical post-login landing.
  if (path === "/" && user) {
    const email = user.email?.toLowerCase() ?? "";
    const appMeta = (user.app_metadata ?? {}) as Record<string, unknown>;
    const provisioned = appMeta.provisioned === true;
    if (isAllowedToSignIn(email) || provisioned) {
      const dashUrl = url.clone();
      dashUrl.pathname = "/choose-platform";
      return NextResponse.redirect(dashUrl);
    }
  }

  return response;
}
