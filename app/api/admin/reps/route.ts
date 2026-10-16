import { NextResponse } from "next/server";
import { isAdminProfile } from "@/lib/auth/roles";
import { createClient } from "@/lib/supabase/server";
import { getProfileByUserId } from "@/lib/auth/profile";
import { isAdminEmail } from "@/lib/auth/admin";
import { loadRepsDirectory } from "@/lib/salesforce/queries";


/**
 * Never cached. Admin surfaces read live database and Salesforce state, and a
 * cached response here is not a stale dashboard — it is a save that appears not
 * to have worked. Kate hit exactly that on Settings > Suppliers: unchecking
 * "Active" wrote correctly and the refresh handed back the pre-save list, so
 * the change looked lost when it was already in the database.
 */
export const dynamic = "force-dynamic";

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
  const isAdmin = isAdminProfile(profile, isAdminEmail(data.user.email));
  if (!isAdmin) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  try {
    /**
     * A two-kilobyte answer that was costing megabytes.
     *
     * This mapped the snapshot's reps down to { id, name } for the View
     * Switcher dropdown. Measured on production 2026-10-15: 3227ms against
     * the 8.1MB full snapshot, and still 2365ms against the 3.6MB thin one,
     * because the whole blob has to come back from Postgres, ungzip and
     * JSON.parse before 26 names can be read out of it. It fires on admin
     * page loads.
     *
     * loadRepsDirectory reads a small slice the warm cron writes beside the
     * snapshots, and falls back to the thin snapshot when that slice is
     * missing — which is exactly the previous behavior, so an un-warmed
     * cache is no worse off than before.
     *
     * NOT made lazy instead: view-switcher.tsx pre-fetches deliberately,
     * because fetching on dropdown-open left admins reading "No reps match"
     * for up to thirty seconds. The pre-fetch is right; its cost was wrong.
     */
    const reps = await loadRepsDirectory();
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
