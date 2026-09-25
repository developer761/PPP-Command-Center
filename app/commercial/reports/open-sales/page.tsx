import { redirect } from "next/navigation";
import { requireReportAccess } from "@/lib/commercial/reports/access";
import { createClient } from "@/lib/supabase/server";
import { getProfileByUserId, platformAccess } from "@/lib/auth/profile";
import { getDealReportRows, OPEN_SALES_SPEC, openSalesRows } from "@/lib/commercial/reports/tomco/opportunities";
import { TomcoReportPage, viewIndex } from "@/components/commercial/tomco-report-page";

export const metadata = { title: "Open sales" };

export const dynamic = "force-dynamic";

const VIEWS = [
  { key: "status", label: "By status" },
  { key: "gc", label: "By GC" },
];

export default async function OpenSalesPage({ searchParams }: { searchParams: Promise<{ view?: string }> }) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/");
  const profile = await getProfileByUserId(user.id);
  if (!platformAccess(profile).hasNewPlatform) redirect("/commercial");
  await requireReportAccess(user.id, user.email, "open-sales");

  const sp = await searchParams;
  const rows = openSalesRows(await getDealReportRows());

  return (
    <TomcoReportPage
      spec={OPEN_SALES_SPEC}
      rows={rows}
      href="/commercial/reports/open-sales"
      view={viewIndex(VIEWS, sp.view)}
      views={VIEWS}
      emptyHint="Every won job is closed out. Open sales appear here while work is still running."
    />
  );
}
