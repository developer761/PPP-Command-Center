import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";

const PPP_DOMAIN = "@precisionpaintingplus.net";

/**
 * Runs on every request. Refreshes the user's auth session (rotates expiring
 * tokens), gates protected routes, and enforces the @precisionpaintingplus.net
 * domain restriction (defense-in-depth on top of the OAuth Internal consent).
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

  // Protect /dashboard/* and /api/v1/* — require auth + correct domain
  const isProtected =
    path.startsWith("/dashboard") || path.startsWith("/api/v1");

  if (isProtected) {
    if (!user) {
      const loginUrl = url.clone();
      loginUrl.pathname = "/";
      loginUrl.searchParams.set("redirectTo", path);
      return NextResponse.redirect(loginUrl);
    }

    // Domain guard — refuse any non-PPP email
    const email = user.email?.toLowerCase() ?? "";
    if (!email.endsWith(PPP_DOMAIN)) {
      await supabase.auth.signOut();
      const denyUrl = url.clone();
      denyUrl.pathname = "/";
      denyUrl.searchParams.set("error", "domain_not_allowed");
      return NextResponse.redirect(denyUrl);
    }
  }

  // If a signed-in user hits the login page, send them to the dashboard.
  if (path === "/" && user) {
    const email = user.email?.toLowerCase() ?? "";
    if (email.endsWith(PPP_DOMAIN)) {
      const dashUrl = url.clone();
      dashUrl.pathname = "/dashboard";
      return NextResponse.redirect(dashUrl);
    }
  }

  return response;
}
