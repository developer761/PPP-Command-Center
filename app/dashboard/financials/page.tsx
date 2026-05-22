import PageHeader from "@/components/page-header";
import { loadDashboardData } from "@/lib/data-source";
import FinancialsView from "@/components/financials-view";

export const dynamic = "force-dynamic";

type SP = Promise<Record<string, string | string[] | undefined>>;

export default async function FinancialsPage({ searchParams }: { searchParams: SP }) {
  const sp = await searchParams;
  const bundle = await loadDashboardData(sp);
  return <FinancialsView bundle={bundle} />;
}
