import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { getProfileByUserId } from "@/lib/auth/profile";
import { isAdminEmail } from "@/lib/auth/admin";
import { deliverMaterialsAlert } from "@/lib/alerts/materials-alerts";
import { opsAlertRecipients } from "@/lib/customer-form/sf-failure-alert";

/**
 * POST /api/admin/test-materials-alert — prove the R6.1 channel works.
 *
 * Sends one real alert down the real path and reports WHICH channel carried it.
 * Naming the channel is the point: "sent" on its own would let a misconfigured
 * webhook that silently fell through to email look perfectly healthy, which is
 * the exact class of quiet failure this alerting exists to end.
 *
 * Dedup is bypassed so pressing it twice actually sends twice.
 *
 * Admin-only.
 */
export const dynamic = "force-dynamic";

export async function POST() {
  const supabase = await createClient();
  const { data } = await supabase.auth.getUser();
  if (!data?.user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const profile = await getProfileByUserId(data.user.id);
  if (!(profile?.is_admin ?? isAdminEmail(data.user.email))) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  const result = await deliverMaterialsAlert(
    {
      kind: "unexpected_error",
      summary: "Test alert — if you can read this in Slack, materials alerting is wired correctly.",
      workOrder: "TEST-0000",
      detail: {
        "Triggered by": data.user.email ?? "unknown admin",
        "Nothing is wrong": "This was sent deliberately from Settings.",
      },
    },
    { bypassDedup: true }
  );

  return NextResponse.json({
    ok: result.delivered,
    via: result.via,
    detail: result.detail,
    slackWebhookConfigured: Boolean(process.env.PPP_MATERIALS_SLACK_WEBHOOK?.trim()),
    emailFallbackRecipients: opsAlertRecipients(),
    meaning:
      result.via === "slack"
        ? "Slack is wired. Nothing further to do."
        : result.via === "email"
          ? "Slack did NOT accept it — this went to ops email instead. Check PPP_MATERIALS_SLACK_WEBHOOK."
          : "Nothing was delivered. Set PPP_MATERIALS_SLACK_WEBHOOK, or PPP_SF_FAILURE_ALERT_EMAILS as a fallback.",
  });
}
