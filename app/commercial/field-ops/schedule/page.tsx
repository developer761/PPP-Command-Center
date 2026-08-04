import { redirect } from "next/navigation";
import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { assertCommercialAccess } from "@/lib/commercial/auth";
import { getProfileByUserId } from "@/lib/auth/profile";
import { isAdminEmail } from "@/lib/auth/admin";
import { getWeekSchedule, mondayOf, todayEtIso } from "@/lib/commercial/field-ops/schedule";
import { listJobs } from "@/lib/commercial/field-ops/jobs";
import { WeekGrid } from "@/components/commercial/week-grid";

export const dynamic = "force-dynamic";

export default async function SchedulePage({
  searchParams,
}: {
  searchParams: Promise<{ week?: string }>;
}) {
  const supabase = await createClient();
  const { data } = await supabase.auth.getUser();
  const user = data?.user;
  if (!user) redirect("/");
  await assertCommercialAccess(user.id);
  const profile = await getProfileByUserId(user.id);
  if (!(profile?.is_admin ?? isAdminEmail(user.email))) redirect("/commercial");

  const sp = await searchParams;
  const weekParam = /^\d{4}-\d{2}-\d{2}$/.test(sp.week ?? "") ? sp.week! : todayEtIso();
  const monday = mondayOf(weekParam);

  const [schedule, jobs] = await Promise.all([getWeekSchedule(monday), listJobs()]);
  const jobOpts = jobs.map((j) => ({ id: j.id, name: j.name, job_code: j.job_code, prevailing_wage: j.prevailing_wage }));

  return (
    <div className="max-w-6xl mx-auto px-4 sm:px-6 py-6">
      <div className="mb-4">
        <Link href="/commercial/field-ops" className="text-[12px] font-semibold text-cc-brand-700 hover:underline">&larr; Field Ops</Link>
        <h1 className="font-condensed text-2xl sm:text-3xl font-black text-ppp-charcoal tracking-tight leading-none mt-1">Week Grid</h1>
        <p className="text-[13px] text-ppp-charcoal-500 mt-1">Schedule the crew. Type hours in a cell to put someone on a job that day. Totals update live.</p>
      </div>
      <WeekGrid
        key={schedule.weekStart}
        weekStart={schedule.weekStart}
        days={schedule.days}
        employees={schedule.employees}
        jobs={jobOpts}
        todayIso={todayEtIso()}
      />
    </div>
  );
}
