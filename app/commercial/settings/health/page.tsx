import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { getProfileByUserId } from "@/lib/auth/profile";
import { isAdminEmail } from "@/lib/auth/admin";
import HealthChecksView from "@/components/health-checks-view";

/**
 * Commercial CC · Setup Health — admin-only diagnostic page.
 *
 * Mirrors /dashboard/settings/health visually (same shared component),
 * scoped to the Commercial CC dependency surface area. Pulls from
 * /api/admin/commercial-health which aggregates every Stage 0-3
 * wire-up: Supabase commercial tables, Resend commercial pool, daily
 * cron freshness, archive HMAC + bucket, migrations 018-037, Slack
 * webhook configuration.
 *
 * Auto-refreshes every 30s when the tab is visible; pauses when
 * backgrounded (battery-friendly on mobile). Click any row → expands
 * to show the full detail message + remediation hint.
 *
 * Admin-only gate uses the same pattern as the PPP health page
 * (profile.is_admin OR email matches isAdminEmail allowlist).
 */

export const dynamic = "force-dynamic";

export default async function CommercialHealthPage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/");
  const profile = await getProfileByUserId(user.id);
  const isAdmin = profile?.is_admin ?? isAdminEmail(user.email);
  if (!isAdmin) redirect("/commercial");

  return (
    <div className="space-y-5">
      <header>
        <span aria-hidden className="block h-[3px] w-10 rounded-full mb-3 bg-cc-brand-600" />
        <div className="flex flex-wrap items-center gap-2 mb-2">
          <h1 className="text-2xl sm:text-3xl font-bold tracking-tight text-ppp-charcoal">
            Setup Health
          </h1>
          <span className="inline-flex items-center text-[10px] font-bold tracking-widest uppercase text-cc-brand-700 bg-cc-brand-50 border border-cc-brand-200 px-2 py-0.5 rounded">
            Admin
          </span>
        </div>
        <p className="text-sm text-ppp-charcoal-500">
          Live status of every wire-up for the Commercial Command Center. Auto-refreshes every 30 seconds. Tap any row to see the fix.
        </p>
      </header>
      <HealthChecksView
        endpoint="/api/admin/commercial-health"
        groupMeta={{
          platform: {
            heading: "Platform setup",
            subhead:
              "Environment variables, database connection, cron auth, and the Slack alerting pipeline.",
          },
          commercial_cc: {
            heading: "Commercial CC features",
            subhead:
              "Per-stage dependencies: notifications, BCC archive, pinned notes + @mentions, and the migration chain.",
          },
        }}
        showSlackTest
      />
    </div>
  );
}
