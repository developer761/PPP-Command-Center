import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { getProfileByUserId } from "@/lib/auth/profile";
import { isAdminEmail } from "@/lib/auth/admin";
import { loadSalesforceSnapshot } from "@/lib/salesforce/queries";

/**
 * Admin-only rep directory. Used by the View Switcher dropdown so an
 * impersonating admin can switch to any other rep — the regular
 * /api/search/index returns a viewer-scoped snapshot, which would
 * collapse the dropdown to a single rep while impersonating.
 *
 * Returns 403 for non-admins. Always returns the unscoped rep list
 * (admins should be able to see every rep regardless of current view).
 */
export async function GET() {
  const supabase = await createClient();
  const { data } = await supabase.auth.getUser();
  if (!data?.user) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const profile = await getProfileByUserId(data.user.id);
  const isAdmin = profile?.is_admin ?? isAdminEmail(data.user.email);
  if (!isAdmin) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  try {
    const snap = await loadSalesforceSnapshot();
    const reps = snap.reps
      .map((r) => ({ id: r.id, name: r.name }))
      .sort((a, b) => a.name.localeCompare(b.name));
    return NextResponse.json(
      { reps },
      {
        headers: {
          // Rep list rarely changes; fires on every dashboard chrome mount
          // from View Switcher + Impersonation Banner. 15-min cache + SWR
          // keeps the dropdown instant without staling beyond the SF
          // snapshot's own 30-min TTL.
          "Cache-Control": "private, max-age=900, stale-while-revalidate=900",
        },
      }
    );
  } catch (err) {
    console.error("[admin/reps] failed:", err);
    return NextResponse.json({ reps: [] });
  }
}
