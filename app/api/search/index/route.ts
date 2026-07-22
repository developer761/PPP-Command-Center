import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { loadDashboardData } from "@/lib/data-source";
import { workTypeRequiresMaterials } from "@/lib/salesforce/materials";

/**
 * Lazy-load the global-search projection. Called from GlobalSearch on first
 * user focus. Keeps the dashboard layout fast (chrome renders instantly)
 * while preserving full search functionality once the user actually engages.
 *
 * Returns a slim projection — not the full snapshot. Caps WOs at 500 most
 * recent so the client bundle stays under ~200KB.
 */
export async function GET(request: Request) {
  const supabase = await createClient();
  const { data } = await supabase.auth.getUser();
  if (!data?.user) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  // Honor ?view_as= / ?scope= so the global search index respects the
  // viewer's current scope (a rep searching shouldn't surface other reps').
  const sp: Record<string, string> = {};
  const url = new URL(request.url);
  const viewAs = url.searchParams.get("view_as");
  const scope = url.searchParams.get("scope");
  if (viewAs) sp.view_as = viewAs;
  if (scope) sp.scope = scope;

  try {
    const bundle = await loadDashboardData(sp);
    if (!bundle.snapshot) {
      return NextResponse.json({ reps: [], accounts: [], workOrders: [] });
    }
    return NextResponse.json({
      reps: bundle.snapshot.reps.map((r) => ({
        id: r.id,
        name: r.name,
        email: r.email,
        region: null,
      })),
      accounts: bundle.snapshot.accounts.map((a) => ({
        id: a.id,
        name: a.name,
        type: a.type,
        region: a.region,
      })),
      workOrders: bundle.snapshot.workOrders
        // Kate 2026-07-22 (#10): drop work orders that clutter search and are
        // never material-order targets — estimates / appointments / inspections
        // / consultations (non-material work types) and not-yet-started
        // "pending" WOs. Closed/completed WOs are KEPT so staff can still search
        // history. (#12): with the noise removed, raise the cap 500 → 2000 so a
        // valid WO isn't missing just because it fell outside the newest 500.
        .filter(
          (w) =>
            workTypeRequiresMaterials(w.workTypeName) &&
            !/pending/i.test(w.status ?? "")
        )
        .slice()
        .sort((a, b) => (b.createdDate ?? "").localeCompare(a.createdDate ?? ""))
        .slice(0, 2000)
        .map((w) => ({
          id: w.id,
          workOrderNumber: w.workOrderNumber,
          accountId: w.accountId,
          accountName: w.accountName,
          status: w.status,
          ownerName: w.ownerName,
          opportunityId: w.opportunityId,
        })),
    }, {
      // Search index derives from the snapshot (30-min TTL). Browser-side
      // 5-min cache + 5-min stale-while-revalidate means repeat search
      // opens within a session skip the round-trip + the snapshot
      // derivation. `private` because viewer-scoped (worker vs admin
      // sees different rows). Audit 2026-06-08.
      headers: { "Cache-Control": "private, max-age=300, stale-while-revalidate=300" },
    });
  } catch (err) {
    console.error("[search-index] failed:", err);
    return NextResponse.json({ reps: [], accounts: [], workOrders: [] });
  }
}
