import RepIndexView from "@/components/rep-index-view";
import { loadDashboardData } from "@/lib/data-source";
import { requireAnalyticsAccess } from "@/lib/auth/require-analytics";

export const dynamic = "force-dynamic";

type SP = Promise<Record<string, string | string[] | undefined>>;

export default async function RepIndexPage({ searchParams }: { searchParams: SP }) {
  // R4.1 — an account manager has no analytics access. Guarded here, not
  // just hidden in the nav, so a typed URL or an old bookmark can't reach it.
  await requireAnalyticsAccess();
  const sp = await searchParams;
  const bundle = await loadDashboardData(sp);
  return <RepIndexView bundle={bundle} />;
}
