import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { getProfileByUserId } from "@/lib/auth/profile";
import { isAdminEmail } from "@/lib/auth/admin";
import { capabilitiesFor, normalizeRole, homeHrefFor } from "@/lib/auth/roles";
import MeasureTool from "@/components/measure-tool";

export const dynamic = "force-dynamic";

/**
 * Measure — one button, then decide where the number goes.
 *
 * This replaced a room-first page: pick a job, pick a room, pick one of three
 * capture methods, and the number landed in a Length/Width/Ceiling box. Karan's
 * verdict was that it was confusing, and it was — every one of those steps was
 * a decision standing between someone and the thing they came to do. Apple's
 * Measure asks for none of them.
 *
 * The room-first surfaces (address lookup, per-room grid, walk-the-room) are
 * not gone; they were the right idea in the wrong order and will come back
 * behind the measurement rather than in front of it.
 *
 * Gated on canEnterColors — measuring is field work an Account Manager does.
 * Ordering the paint stays admin-only, elsewhere.
 */
export default async function MeasurePage() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/");
  const profile = await getProfileByUserId(user.id);
  if (profile && profile.is_active === false && !isAdminEmail(user.email)) redirect("/");
  const role = normalizeRole(profile?.role, profile?.is_admin ?? isAdminEmail(user.email));
  if (!capabilitiesFor(role).canEnterColors) redirect(homeHrefFor(role));

  return (
    <div className="animate-fade-up max-w-3xl mx-auto">
      <MeasureTool />
    </div>
  );
}
