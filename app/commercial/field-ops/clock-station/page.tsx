import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { assertCommercialAccess } from "@/lib/commercial/auth";
import { getProfileByUserId } from "@/lib/auth/profile";
import { isAdminEmail } from "@/lib/auth/admin";
import { isCrewOnlyUser } from "@/lib/commercial/crew-access";
import { listEmployees, listClockablePins } from "@/lib/commercial/field-ops/employees";
import { ClockStation } from "@/components/commercial/clock-station";

export const dynamic = "force-dynamic";

export default async function ClockStationPage() {
  const supabase = await createClient();
  const { data } = await supabase.auth.getUser();
  if (!data?.user) redirect("/");
  // The kiosk is explicitly crew-reachable (PIN-gated).
  await assertCommercialAccess(data.user.id, { allowCrew: true });
  // Admin OR crew. The kiosk is the shop tablet; it was admin-only because a
  // non-admin commercial user could brute-force a 4-digit PIN and clock other
  // people (payroll fraud, audit round 2). Karan 2026-08 opened it to the Crew
  // role — "they can have the pin and everything is fine" — since a crew login
  // is now confined to their own field-ops surfaces anyway, and the alternative
  // was every crew member sharing one admin session on the tablet.
  const profile = await getProfileByUserId(data.user.id);
  const isAdmin = profile?.is_admin ?? isAdminEmail(data.user.email);
  const isCrew = await isCrewOnlyUser(data.user.id);
  if (!isAdmin && !isCrew) redirect("/commercial/field-ops/overview");

  const [employees, pinned] = await Promise.all([listEmployees(), listClockablePins()]);
  // The shop tablet (admin session) shows the whole roster — that's the point of
  // a kiosk. A CREW session gets only themselves: handing a painter's personal
  // phone the full staff list, with who does and doesn't have a PIN set, is a
  // roster leak and a map of which 4-digit codes are worth guessing. The API
  // binds crew to their own employee regardless, so this keeps the UI honest
  // about what it can actually do.
  const { getEmployeeForUser } = await import("@/lib/commercial/crew-access");
  const me = isCrew && !isAdmin ? await getEmployeeForUser(data.user.id) : null;
  const visible = me ? employees.filter((e) => e.id === me.id) : employees;
  const list = visible.map((e) => ({ id: e.id, display_name: e.display_name, has_pin: pinned.has(e.id) }));

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
