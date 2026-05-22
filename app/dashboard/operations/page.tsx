import { loadDashboardData } from "@/lib/data-source";
import OperationsView from "@/components/operations-view";

export const dynamic = "force-dynamic";

type SP = Promise<Record<string, string | string[] | undefined>>;

export default async function OperationsPage({ searchParams }: { searchParams: SP }) {
  const sp = await searchParams;
  const bundle = await loadDashboardData(sp);
  return <OperationsView bundle={bundle} />;
}
