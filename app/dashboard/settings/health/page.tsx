import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { getProfileByUserId } from "@/lib/auth/profile";
import { isAdminEmail } from "@/lib/auth/admin";
import PageHeader from "@/components/page-header";
import HealthChecksView from "@/components/health-checks-view";

/**
 * Setup Health admin page — one place to verify everything that could
 * silently break a customer-facing flow is wired up. Green = ready,
 * orange/red = fix this before it bites.
 *
 * Workers shouldn't see this (it surfaces env-var status + DB migration
 * state, which is admin-only operational context).
 */

export const dynamic = "force-dynamic";

export default async function HealthPage() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/");
  const profile = await getProfileByUserId(user.id);
  const isAdmin = profile?.is_admin ?? isAdminEmail(user.email);
  if (!isAdmin) redirect("/dashboard");

  return (
    <div className="animate-fade-up">
      <PageHeader
        title="Setup Health"
        subtitle="Quick scan of everything that has to be wired up for the platform to run end to end. Green means good, orange/red means fix it before it costs you an order."
      />
      <HealthChecksView
        endpoint="/api/admin/health"
        groupMeta={{
          platform: {
            heading: "Platform setup",
            subhead:
              "Environment variables + database migrations the platform needs to run end-to-end.",
          },
          data: {
            heading: "Salesforce data quality",
            subhead:
              "PPP-side data that the platform reads — things to fix in Salesforce or in supplier settings.",
          },
        }}
        showSlackTest
      />
    </div>
  );
}
