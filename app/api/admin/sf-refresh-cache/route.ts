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
  return NextResponse.redirect(`${origin}/dashboard/integrations?sf_cache_cleared=1`, 303);
}
