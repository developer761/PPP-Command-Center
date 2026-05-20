import DashboardView from "@/components/dashboard-view";
import { loadDashboardData } from "@/lib/data-source";

// Force dynamic rendering so SF data refreshes per page load (subject to the
// 5-min server-side snapshot cache inside lib/salesforce/queries.ts).
export const dynamic = "force-dynamic";

export default async function DashboardPage() {
  const bundle = await loadDashboardData();
  return <DashboardView bundle={bundle} />;
}
