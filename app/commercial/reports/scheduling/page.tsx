import { redirect } from "next/navigation";
import { requireReportAccess } from "@/lib/commercial/reports/access";
import { createClient } from "@/lib/supabase/server";
import { getProfileByUserId, platformAccess } from "@/lib/auth/profile";
import { getDealReportRows, SCHEDULING_SPEC, schedulingRows } from "@/lib/commercial/reports/tomco/opportunities";
import { TomcoReportPage, viewIndex } from "@/components/commercial/tomco-report-page";

export const dynamic = "force-dynamic";

const VIEWS = [
  { key: "status", label: "By status" },
  { key: "gc", label: "By GC" },
];

export default async function SchedulingReportPage({ searchParams }: { searchParams: Promise<{ view?: string }> }) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/");
  const profile = await getProfileByUserId(user.id);
  if (!platformAccess(profile).hasNewPlatform) redirect("/commercial");
  await requireReportAccess(user.id, user.email, "scheduling");

  const sp = await searchParams;
  const rows = schedulingRows(await getDealReportRows());

  return (
    <TomcoReportPage
      spec={SCHEDULING_SPEC}
      rows={rows}
      href="/commercial/reports/scheduling"
      view={viewIndex(VIEWS, sp.view)}
      views={VIEWS}
      emptyHint="Nothing is in coordination, on site or on hold right now."
    />
  );
}
