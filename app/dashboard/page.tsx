import DashboardView from "@/components/dashboard-view";
import { loadDashboardData } from "@/lib/data-source";

// Force dynamic rendering so SF data refreshes per page load (subject to the
// 5-min server-side snapshot cache inside lib/salesforce/queries.ts).
export const dynamic = "force-dynamic";

type SP = Promise<Record<string, string | string[] | undefined>>;

export default async function DashboardPage({
  searchParams,
}: {
  searchParams: SP;
}) {
  const sp = await searchParams;
  const bundle = await loadDashboardData(sp);
  return <DashboardView bundle={bundle} />;
}
