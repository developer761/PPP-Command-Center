import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { loadDashboardData } from "@/lib/data-source";

/**
 * Lazy-load the global-search projection. Called from GlobalSearch on first
 * user focus. Keeps the dashboard layout fast (chrome renders instantly)
 * while preserving full search functionality once the user actually engages.
 *
 * Returns a slim projection — not the full snapshot. Caps WOs at 500 most
 * recent so the client bundle stays under ~200KB.
 */
export async function GET() {
  const supabase = await createClient();
  const { data } = await supabase.auth.getUser();
  if (!data?.user) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  try {
    const bundle = await loadDashboardData();
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
        .slice()
        .sort((a, b) => (b.createdDate ?? "").localeCompare(a.createdDate ?? ""))
        .slice(0, 500)
        .map((w) => ({
          id: w.id,
          workOrderNumber: w.workOrderNumber,
          accountName: w.accountName,
          status: w.status,
          ownerName: w.ownerName,
          opportunityId: w.opportunityId,
        })),
    });
  } catch (err) {
    console.error("[search-index] failed:", err);
    return NextResponse.json({ reps: [], accounts: [], workOrders: [] });
  }
}
