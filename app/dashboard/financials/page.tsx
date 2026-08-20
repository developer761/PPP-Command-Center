import PageHeader from "@/components/page-header";
import { loadDashboardData } from "@/lib/data-source";
import FinancialsView from "@/components/financials-view";
import { requireAnalyticsAccess } from "@/lib/auth/require-analytics";

export const dynamic = "force-dynamic";

type SP = Promise<Record<string, string | string[] | undefined>>;

export default async function FinancialsPage({ searchParams }: { searchParams: SP }) {
  // R4.1 — an account manager has no analytics access. Guarded here, not
  // just hidden in the nav, so a typed URL or an old bookmark can't reach it.
  await requireAnalyticsAccess();
  const sp = await searchParams;
  const bundle = await loadDashboardData(sp);
  return <FinancialsView bundle={bundle} />;
}
