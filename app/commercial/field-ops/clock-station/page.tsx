import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { assertCommercialAccess } from "@/lib/commercial/auth";
import { getProfileByUserId } from "@/lib/auth/profile";
import { isAdminEmail } from "@/lib/auth/admin";
import { listEmployees, listClockablePins } from "@/lib/commercial/field-ops/employees";
import { ClockStation } from "@/components/commercial/clock-station";

export const dynamic = "force-dynamic";

export default async function ClockStationPage() {
  const supabase = await createClient();
  const { data } = await supabase.auth.getUser();
  if (!data?.user) redirect("/");
  await assertCommercialAccess(data.user.id);
  // Admin-only: the kiosk is the office/shop tablet (an admin session). Crew use
  // their login-less magic link instead — audit round 2.
  const profile = await getProfileByUserId(data.user.id);
  if (!(profile?.is_admin ?? isAdminEmail(data.user.email))) redirect("/commercial/field-ops/overview");

  const [employees, pinned] = await Promise.all([listEmployees(), listClockablePins()]);
  const list = employees.map((e) => ({ id: e.id, display_name: e.display_name, has_pin: pinned.has(e.id) }));

  return (
    <div className="pb-8">
      <div className="mb-4 text-center">
        <h1 className="font-condensed text-2xl sm:text-3xl font-black text-ppp-charcoal tracking-tight leading-none">Clock Station</h1>
        <p className="text-[13px] text-ppp-charcoal-500 mt-1">Backup clock — for the shop tablet or when a painter&rsquo;s link isn&rsquo;t working.</p>
      </div>
      <ClockStation employees={list} />
    </div>
  );
}
