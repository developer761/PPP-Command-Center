import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { clearSalesforceCache } from "@/lib/salesforce/queries";

/**
 * Bust the 5-min Salesforce snapshot cache. Triggered by the topbar refresh
 * button (signed-in user only — anyone on the platform can request fresh data).
 *
 * Defenses against cache-bust thrash / CSRF:
 *   1. Origin/Referer must be same-origin (blocks cross-site POST).
 *   2. Per-user 30-second cooldown — successive clicks within 30s are no-ops
 *      that still 303 back so the topbar UX doesn't break.
 *   3. We do NOT run SF queries here; we just clear the cache. The next page
 *      load triggers the actual fetch, deduped at the snapshot layer.
 */
const REFRESH_COOLDOWN_MS = 30_000;
const lastRefreshByUser = new Map<string, number>();

export async function POST(request: Request) {
  const supabase = await createClient();
  const { data } = await supabase.auth.getUser();
  if (!data?.user) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const { origin } = new URL(request.url);

  // Same-origin guard. The topbar form submits as a normal HTML POST with no
  // CSRF token, so this is the cheapest defense.
  const originHeader = request.headers.get("origin");
  const refererHeader = request.headers.get("referer");
  const sameOrigin =
    (originHeader && originHeader === origin) ||
    (refererHeader && (() => {
      try {
        return new URL(refererHeader).origin === origin;
      } catch {
        return false;
      }
    })());
  if (!sameOrigin) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  // Per-user cooldown: drop the cache only if we haven't done so in the last 30s.
  const last = lastRefreshByUser.get(data.user.id) ?? 0;
  const now = Date.now();
  if (now - last >= REFRESH_COOLDOWN_MS) {
    lastRefreshByUser.set(data.user.id, now);
    clearSalesforceCache();
  }

  // Redirect back to the page the user clicked from. Same-origin guard above
  // already validated `refererHeader`, so we can trust it here.
  if (refererHeader) {
    return NextResponse.redirect(refererHeader, 303);
  }
  return NextResponse.redirect(`${origin}/dashboard/integrations?sf_cache_cleared=1`, 303);
}
