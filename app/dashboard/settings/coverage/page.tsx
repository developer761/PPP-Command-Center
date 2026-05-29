import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { getProfileByUserId } from "@/lib/auth/profile";
import { isAdminEmail } from "@/lib/auth/admin";
import PageHeader from "@/components/page-header";
import CoverageSettingsEditor from "@/components/coverage-settings-editor";

/**
 * Admin-only page to tune the paint gallons calculator's constants (coverage
 * rate, buffer, opening deductions, trim casings, default height/openings)
 * without a deploy — per Katie's estimating spec ("PPP will tune these").
 */

export const dynamic = "force-dynamic";

export default async function CoverageSettingsPage() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/");
  const profile = await getProfileByUserId(user.id);
  const isAdmin = profile?.is_admin ?? isAdminEmail(user.email);
  if (!isAdmin) redirect("/dashboard");

  return (
    <div className="animate-fade-up">
      <PageHeader
        title="Paint Coverage Settings"
        subtitle="Tune the gallon calculator without a deploy — coverage rate, buffer, opening deductions, trim casings, and the defaults used when a room's dimensions aren't captured."
      />
      <CoverageSettingsEditor />
    </div>
  );
}
