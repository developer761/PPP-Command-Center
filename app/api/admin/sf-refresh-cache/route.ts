import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { clearSalesforceCache } from "@/lib/salesforce/queries";

/**
 * Bust the 5-min Salesforce snapshot cache. Useful after a data fix in SF
 * (or a code fix to the snapshot query) so the dashboard re-fetches immediately
 * instead of waiting for the cache to expire.
 *
 * Auth: must be signed in. (We're inside the PPP-domain-only OAuth boundary
 * already; no separate admin role yet.)
 */
export async function POST(request: Request) {
  const supabase = await createClient();
  const { data } = await supabase.auth.getUser();
  if (!data?.user) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  clearSalesforceCache();

  const { origin } = new URL(request.url);
  // Redirect back to the page the user clicked from (Referer header) so the
  // topbar refresh button works from anywhere. Falls back to integrations.
  const referer = request.headers.get("referer");
  if (referer) {
    try {
      const url = new URL(referer);
      if (url.origin === origin) {
        // Preserve the user's location, append a freshness pulse.
        return NextResponse.redirect(referer, 303);
      }
    } catch {
      // bad referer — fall through
    }
  }
  return NextResponse.redirect(`${origin}/dashboard/integrations?sf_cache_cleared=1`, 303);
}
