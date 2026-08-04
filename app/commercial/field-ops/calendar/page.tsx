import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { assertCommercialAccess } from "@/lib/commercial/auth";
import { getProfileByUserId } from "@/lib/auth/profile";
import { isAdminEmail } from "@/lib/auth/admin";
import { getMonthOverview, todayEtIso } from "@/lib/commercial/field-ops/schedule";
import { FieldOpsCalendar } from "@/components/commercial/field-ops-calendar";

export const dynamic = "force-dynamic";

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
  const anchor = /^\d{4}-\d{2}-\d{2}$/.test(sp.month ?? "") ? sp.month! : todayEtIso();
  const { monthStart, grid } = await getMonthOverview(anchor);

  return (
    <div className="pb-8">
      <div className="mb-4">
        <h1 className="font-condensed text-2xl sm:text-3xl font-black text-ppp-charcoal tracking-tight leading-none">Calendar</h1>
        <p className="text-[13px] text-ppp-charcoal-500 mt-1">The month at a glance — which jobs are running each day and how many hands are on. Click any day to schedule that week.</p>
      </div>
      <FieldOpsCalendar monthStart={monthStart} grid={grid} todayIso={todayEtIso()} />
    </div>
  );
}
