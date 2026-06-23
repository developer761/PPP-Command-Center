import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { getProfileByUserId } from "@/lib/auth/profile";
import { isAdminEmail } from "@/lib/auth/admin";
import { testSlackWebhook } from "@/lib/observability";

/**
 * POST /api/admin/test-slack-webhook — admin-only "ping Slack" button.
 *
 * Sends a synthetic info-level alert immediately (bypasses dedup +
 * startup grace) so the admin can confirm the webhook URL + Slack
 * channel are correctly wired. Returns ok/error so the UI can show
 * the result inline.
 */

export const dynamic = "force-dynamic";

export async function POST() {
  const supabase = await createClient();
  const { data: auth } = await supabase.auth.getUser();
  if (!auth?.user) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }
  const profile = await getProfileByUserId(auth.user.id);
  const email = (profile?.email ?? auth.user.email ?? "").toLowerCase();
  const isAdmin = (profile?.is_admin ?? false) || isAdminEmail(email);
  if (!isAdmin) {
    return NextResponse.json({ ok: false, error: "forbidden" }, { status: 403 });
  }
  const result = await testSlackWebhook();
  return NextResponse.json(result);
}
