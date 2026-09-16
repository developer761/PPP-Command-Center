import { redirect } from "next/navigation";
import { requireReportAccess } from "@/lib/commercial/reports/access";
import { createClient } from "@/lib/supabase/server";
import { getProfileByUserId, platformAccess } from "@/lib/auth/profile";
import { getDealReportRows, PIPELINE_MANAGER_SPEC, pipelineManagerRows } from "@/lib/commercial/reports/tomco/opportunities";
import { TomcoReportPage, viewIndex } from "@/components/commercial/tomco-report-page";

export const dynamic = "force-dynamic";

const VIEWS = [
  { key: "status", label: "By status" },
  { key: "gc", label: "By GC" },
];

export default async function PipelineManagerPage({ searchParams }: { searchParams: Promise<{ view?: string }> }) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/");
  const profile = await getProfileByUserId(user.id);
  if (!platformAccess(profile).hasNewPlatform) redirect("/commercial");
  await requireReportAccess(user.id, user.email, "pipeline-manager");

  const sp = await searchParams;
  const rows = pipelineManagerRows(await getDealReportRows());

  return (
    <TomcoReportPage
      spec={PIPELINE_MANAGER_SPEC}
      rows={rows}
      href="/commercial/reports/pipeline-manager"
      view={viewIndex(VIEWS, sp.view)}
      views={VIEWS}
      emptyHint="No open bids. A job appears here from the moment it is quoted until it is won or lost."
    />
  );
}
