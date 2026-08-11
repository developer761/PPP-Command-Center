import { createClient } from "@/lib/supabase/server";
import { isCrewOnlyUser } from "@/lib/commercial/crew-access";
import { FieldOpsTabs } from "@/components/commercial/field-ops-tabs";

/**
 * R10 Field Ops layout - a tab bar (Week Grid / Calendar / Job Board / Work
 * Orders / Crew) sits above every field-ops surface. The tab bar is hidden on
 * the bare hub route via the page itself redirecting to the first tab.
 *
 * The tab bar is ALSO hidden for a crew-only login. The one field-ops path a
 * crew member can reach is the clock station, and wrapping it in nine admin
 * tabs meant eight of them bounced silently back to /commercial/crew — while
 * the labels alone advertised Payroll and Approvals to a painter.
 */
export default async function FieldOpsLayout({ children }: { children: React.ReactNode }) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  const crewOnly = user ? await isCrewOnlyUser(user.id) : false;
  return (
    <div className="max-w-6xl mx-auto px-4 sm:px-6 pt-6">
      {!crewOnly && <FieldOpsTabs />}
      {children}
    </div>
  );
}
