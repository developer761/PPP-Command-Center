import "server-only";

import { cache } from "react";
import { createClient } from "@/lib/supabase/server";

/**
 * Per-request cached supabase.auth.getUser().
 *
 * Why: the dashboard layout calls auth.getUser() to gate access, then
 * the page calls auth.getUser() AGAIN via resolveViewer. Same JWT, same
 * request — but each call instantiates a Supabase client and verifies
 * the JWT. Cost is small (~10-50ms per call) but it's pure waste.
 *
 * `cache()` from React dedupes the call within a single React server-
 * render. Layout + page (both inside the same render tree) share one
 * verify per request. Cross-request, it's a no-op — each request gets
 * its own cache, so cookies still drive state correctly.
 *
 * Returns `null` on any failure (no user, expired session, etc.) so
 * callers can treat "no session" identically.
 */
export const getCurrentUser = cache(async () => {
  const supabase = await createClient();
  const { data, error } = await supabase.auth.getUser();
  if (error || !data?.user) return null;
  return data.user;
});
