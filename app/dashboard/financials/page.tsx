import PageHeader from "@/components/page-header";
import { loadDashboardData } from "@/lib/data-source";
import FinancialsView from "@/components/financials-view";

export const dynamic = "force-dynamic";

export default async function FinancialsPage() {
  const bundle = await loadDashboardData();
  return <FinancialsView bundle={bundle} />;
}
