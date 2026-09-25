import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { assertCommercialAccess } from "@/lib/commercial/auth";
import { getProfileByUserId } from "@/lib/auth/profile";
import { isAdminEmail } from "@/lib/auth/admin";
import { getMonthOverview, getWeekOverview, todayEtIso } from "@/lib/commercial/field-ops/schedule";
import { listEmployees } from "@/lib/commercial/field-ops/employees";
import { listJobs, ensureJobsForSentWorkOrders, cleanOrphanedJobs } from "@/lib/commercial/field-ops/jobs";
import { FieldOpsCalendar } from "@/components/commercial/field-ops-calendar";

export const metadata = { title: "Calendar" };

export const dynamic = "force-dynamic";

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export default async function FieldOpsCalendarPage({
  searchParams,
}: {
  searchParams: Promise<{ month?: string; week?: string; view?: string }>;
}) {
  const supabase = await createClient();
  const { data } = await supabase.auth.getUser();
  const user = data?.user;
  if (!user) redirect("/");
  await assertCommercialAccess(user.id);
  const profile = await getProfileByUserId(user.id);
  if (!(profile?.is_admin ?? isAdminEmail(user.email))) redirect("/commercial");

  const sp = await searchParams;
  /**
   * Month or week. Karan 2026-09-17: "calendar week view."
   *
   * `?week=` is accepted as an anchor as well as `?view=week`, because
   * /commercial/field-ops/schedule has redirected its old `?week=` links into
   * this page since the Week Grid was retired — and those links landed on a
   * month with the week silently ignored. Now they land on the week they name.
   */
  const anchor =
    (DATE_RE.test(sp.week ?? "") ? sp.week : null) ??
    (DATE_RE.test(sp.month ?? "") ? sp.month! : todayEtIso());
  const mode: "month" | "week" = sp.view === "week" || DATE_RE.test(sp.week ?? "") ? "week" : "month";
  // Safety net: any deal WO marked "sent" but missing its schedulable twin (e.g.
  // a send-time create that failed) gets one now, so it always shows in the picker.
  await Promise.all([ensureJobsForSentWorkOrders(user.id), cleanOrphanedJobs(user.id)]);
  const [overview, employees, jobs] = await Promise.all([
    mode === "week" ? getWeekOverview(anchor) : getMonthOverview(anchor),
    listEmployees(),
    listJobs(),
  ]);
  const grid = overview.grid;
  // The anchor the calendar pages from: the 1st in month mode, the Sunday in
  // week mode. Same prop either way, so the component has one concept of
  // "where am I" rather than two.
  const periodStart = "monthStart" in overview ? overview.monthStart : overview.weekStart;

  return (
    <div className="pb-8">
      <div className="mb-4">
        <h1 className="font-condensed text-2xl sm:text-3xl font-black text-ppp-charcoal tracking-tight leading-none">Calendar</h1>
        <p className="text-[13px] text-ppp-charcoal-500 mt-1">Click any day to put crew on a work order — set their hours and a note, and they&rsquo;re emailed automatically. </p>
        {/* DESKTOP ONLY, because the behaviour is. On a phone the calendar
            becomes an agenda and each day is one button, so the crew names
            inside it are plain text — tapping one opens the day, not the
            person. Nesting a button inside that button would be invalid
            markup and swallow the tap, so the honest fix is to stop promising
            it where it does not happen. */}
        <p className="text-[13px] text-ppp-charcoal-500">
          <span className="hidden sm:inline">Click a name to see their shift and clock-in status.</span>
          <span className="sm:hidden">Open a day to see who is on it and their clock-in status.</span></p>
      </div>
      <FieldOpsCalendar
        monthStart={periodStart}
        mode={mode}
        grid={grid}
        todayIso={todayEtIso()}
        employees={employees.map((e) => ({ id: e.id, display_name: e.display_name, email: e.email }))}
        jobs={jobs.map((j) => ({ id: j.id, name: j.name, job_code: j.job_code, customer_name: j.customer_name, site_city: j.site_city }))}
      />
    </div>
  );
}
