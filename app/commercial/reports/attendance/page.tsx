import { redirect } from "next/navigation";
import { requireReportAccess } from "@/lib/commercial/reports/access";
import { createClient } from "@/lib/supabase/server";
import { getProfileByUserId, platformAccess } from "@/lib/auth/profile";
import { getAttendanceRows, ATTENDANCE_SPEC } from "@/lib/commercial/reports/tomco/attendance";
import { TomcoReportPage, viewIndex, periodFrom } from "@/components/commercial/tomco-report-page";

export const dynamic = "force-dynamic";

const VIEWS = [
  { key: "crew", label: "By crew, then job" },
  { key: "job", label: "By job, then crew" },
  { key: "month", label: "By month" },
];

export default async function AttendanceReportPage({
  searchParams,
}: {
  searchParams: Promise<{ view?: string; period?: string }>;
}) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/");
  const profile = await getProfileByUserId(user.id);
  if (!platformAccess(profile).hasNewPlatform) redirect("/commercial");
  await requireReportAccess(user.id, user.email, "attendance");

  const sp = await searchParams;
  const period = sp.period ?? "all";
  const from = periodFrom(period);
  const rows = (await getAttendanceRows())
    .filter((r) => !from || r.ymd >= from)
    .sort((a, b) => b.ymd.localeCompare(a.ymd));

  return (
    <TomcoReportPage
      spec={ATTENDANCE_SPEC}
      rows={rows}
      href="/commercial/reports/attendance"
      view={viewIndex(VIEWS, sp.view)}
      views={VIEWS}
      period={period}
      emptyHint="No hours in this window. Attendance appears here as soon as a crew's day is recorded against a job."
      footer={
        <p className="text-[12px] text-ppp-charcoal-500 rounded-lg border border-ppp-charcoal-100 bg-ppp-charcoal-50 px-3 py-2">
          <strong className="text-ppp-charcoal">Hours, not cost.</strong> Tomco&rsquo;s crews are paid through labor
          companies, and that money is already on each job as a Subcontract cost. Putting a rate on these hours as well
          would charge every job twice, so this report counts the work and the job&rsquo;s cost lines count the money.
        </p>
      }
    />
  );
}
