import { loadDashboardData } from "@/lib/data-source";
import OperationsView from "@/components/operations-view";

export const dynamic = "force-dynamic";

export default async function OperationsPage() {
  const bundle = await loadDashboardData();
  return <OperationsView bundle={bundle} />;
}
