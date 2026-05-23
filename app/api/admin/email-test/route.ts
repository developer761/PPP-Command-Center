import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { getProfileByUserId } from "@/lib/auth/profile";
import { isAdminEmail } from "@/lib/auth/admin";
import { sendEmail } from "@/lib/email/resend";

/**
 * Admin-only test endpoint to verify Resend wiring without touching the real
 * customer flow. Fires a plain "hello from Command Center" email to the
 * supplied address.
 *
 *   GET /api/admin/email-test?to=karan@example.com
 *
 * Returns the Resend message id on success so we can trace it in Resend's
 * dashboard. Logs the full sendEmail() result either way.
 */
export async function GET(request: Request) {
  const supabase = await createClient();
  const { data } = await supabase.auth.getUser();
  if (!data?.user) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const profile = await getProfileByUserId(data.user.id);
  const isAdmin = profile?.is_admin ?? isAdminEmail(data.user.email);
  if (!isAdmin) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  const url = new URL(request.url);
  const to = url.searchParams.get("to");
  if (!to || !/^[a-z0-9._+\-]+@[a-z0-9.\-]+$/i.test(to)) {
    return NextResponse.json({
      error: "missing_or_invalid_to",
      hint: "Add ?to=your@email.com to the URL",
    }, { status: 400 });
  }

  const fromAddress = process.env.RESEND_FROM_ADDRESS ?? "(RESEND_FROM_ADDRESS not set)";
  const hasApiKey = !!process.env.RESEND_API_KEY;

  const result = await sendEmail({
    to,
    subject: "Command Center test email — ignore",
    text: [
      "If you got this, Resend is correctly wired.",
      "",
      `Triggered by: ${data.user.email}`,
      `Sender:       ${fromAddress}`,
      `Time:         ${new Date().toISOString()}`,
      "",
      "— Precision Painting Plus Command Center",
    ].join("\n"),
    tags: [{ name: "kind", value: "test" }],
  });

  return NextResponse.json({
    triggeredBy: data.user.email,
    to,
    fromAddress,
    hasApiKey,
    result,
  }, { status: result.ok ? 200 : 500 });
}
