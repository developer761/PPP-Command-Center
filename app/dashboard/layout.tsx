import { redirect } from "next/navigation";
import DashboardChrome from "@/components/dashboard-chrome";
import { createClient } from "@/lib/supabase/server";
import { loadDashboardData } from "@/lib/data-source";

export default async function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  // Middleware should have caught this already; this is defense-in-depth.
  if (!user || !user.email?.toLowerCase().endsWith("@precisionpaintingplus.net")) {
    redirect("/");
  }

  // Derive a friendly display name from Google's profile metadata.
  const meta = (user.user_metadata ?? {}) as Record<string, unknown>;
  const fullName =
    (typeof meta.full_name === "string" && meta.full_name) ||
    (typeof meta.name === "string" && meta.name) ||
    null;
  const firstName = fullName ? fullName.split(" ")[0] : null;
  const initial = (firstName ?? user.email[0] ?? "P").charAt(0).toUpperCase();

  // Build a search projection from the snapshot so the global search bar
  // doesn't have to re-fetch. We pass only the searchable fields, not the
  // whole snapshot, to keep the client bundle lean.
  let searchIndex = null;
  try {
    const bundle = await loadDashboardData();
    if (bundle.snapshot) {
      searchIndex = {
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
        // Cap to 500 most recent WOs for search — full set would balloon
        // the client bundle. Users can drill via rep profile for the rest.
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
      };
    }
  } catch {
    // Search bar gracefully degrades to page-only navigation when SF isn't reachable.
  }

  return (
    <DashboardChrome
      user={{
        email: user.email,
        fullName,
        firstName,
        initial,
      }}
      searchIndex={searchIndex}
    >
      {children}
    </DashboardChrome>
  );
}
