import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { assertCommercialAccess } from "@/lib/commercial/auth";
import { getProfileByUserId } from "@/lib/auth/profile";
import { isAdminEmail } from "@/lib/auth/admin";
import { getMonthOverview, todayEtIso } from "@/lib/commercial/field-ops/schedule";
import { listEmployees } from "@/lib/commercial/field-ops/employees";
import { listJobs, ensureJobsForSentWorkOrders } from "@/lib/commercial/field-ops/jobs";
import { FieldOpsCalendar } from "@/components/commercial/field-ops-calendar";

export const dynamic = "force-dynamic";

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export default async function FieldOpsCalendarPage({
  searchParams,
}: {
  searchParams: Promise<{ month?: string }>;
}) {
  const supabase = await createClient();
  const { data } = await supabase.auth.getUser();
  const user = data?.user;
  if (!user) redirect("/");
  await assertCommercialAccess(user.id);
  const profile = await getProfileByUserId(user.id);
  if (!(profile?.is_admin ?? isAdminEmail(user.email))) redirect("/commercial");

  const sp = await searchParams;
  const anchor = DATE_RE.test(sp.month ?? "") ? sp.month! : todayEtIso();
  // Safety net: any deal WO marked "sent" but missing its schedulable twin (e.g.
  // a send-time create that failed) gets one now, so it always shows in the picker.
  await ensureJobsForSentWorkOrders(user.id);
  const [{ monthStart, grid }, employees, jobs] = await Promise.all([
    getMonthOverview(anchor),
    listEmployees(),
    listJobs(),
  ]);

  return (
    <div className="pb-8">
      <div className="mb-4">
        <h1 className="font-condensed text-2xl sm:text-3xl font-black text-ppp-charcoal tracking-tight leading-none">Calendar</h1>
        <p className="text-[13px] text-ppp-charcoal-500 mt-1">Click any day to put crew on a work order — set their hours and a note, and they&rsquo;re emailed automatically. Click a name to see their shift and clock-in status.</p>
      </div>
      <FieldOpsCalendar
        monthStart={monthStart}
        grid={grid}
        todayIso={todayEtIso()}
        employees={employees.map((e) => ({ id: e.id, display_name: e.display_name, email: e.email }))}
        jobs={jobs.map((j) => ({ id: j.id, name: j.name, job_code: j.job_code, customer_name: j.customer_name, site_city: j.site_city }))}
      />
    </div>
  );
}
