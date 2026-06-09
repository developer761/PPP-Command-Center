import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { getProfileByUserId } from "@/lib/auth/profile";
import { isAdminEmail } from "@/lib/auth/admin";
import { sendCustomerFormInvite } from "@/lib/email/resend";

/**
 * Admin-only test endpoint that fires a sample customer-form invite email
 * to the supplied address — using the CURRENT customer_form_templates
 * config so admin can verify their template edits actually took effect.
 *
 *   GET /api/admin/email-test?to=karan@example.com
 *      Optional: ?name=Jane%20Doe  &wo=00012345
 *
 * Previously this sent a hardcoded "Resend wired" plain message and did
 * NOT go through the template system — admin would edit templates,
 * trigger this, and see no change (because the test path bypassed the
 * templates entirely). Fixed 2026-05-26 in response to Karan's report:
 * "I changed the email template on admin and clicked save and then resent
 * a test email and the template seems like it didnt change."
 *
 * The test email is clearly labeled "[TEST]" in the subject so admin can
 * recognize it as a preview and not a real customer send. The form link
 * is also a placeholder token (TEST_TOKEN_NOT_REAL) so clicking it lands
 * on the standard "not found" error state.
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
  // Require a TLD on the email — matches the regex used by every other
  // admin send route (customer-form/create, supplier-order/send,
  // supplier-settings). Without the TLD requirement, `?to=foo@bar` was
  // accepted here and silently rejected by Resend, leaving admin to think
  // the template change worked.
  if (!to || !/^[a-z0-9._+\-]+@[a-z0-9.\-]+\.[a-z]{2,}$/i.test(to)) {
    return NextResponse.json({
      error: "missing_or_invalid_to",
      hint: "Add ?to=your@email.com to the URL",
    }, { status: 400 });
  }
  const fakeName = url.searchParams.get("name") || "Test Customer";
  const fakeWoNumber = url.searchParams.get("wo") || "00099999-TEST";
  const baseUrl = process.env.NEXT_PUBLIC_APP_URL?.replace(/\/$/, "")
    || new URL(request.url).origin;
  const fakeFormUrl = `${baseUrl}/select/TEST_TOKEN_NOT_REAL`;

  const fromAddress = process.env.RESEND_FROM_ADDRESS ?? "(RESEND_FROM_ADDRESS not set)";
  const hasApiKey = !!process.env.RESEND_API_KEY;

  // Use the REAL customer-form invite path so admin sees their template
  // edits reflected. Prepend "[TEST]" via subjectOverride so the email
  // reads as a preview, not a live customer send.
  const result = await sendCustomerFormInvite({
    to,
    customerName: fakeName,
    workOrderNumber: fakeWoNumber,
    formUrl: fakeFormUrl,
    subjectOverride: `[TEST] Template preview · ${new Date().toLocaleString("en-US", { hour: "numeric", minute: "2-digit" })}`,
  });

  return NextResponse.json({
    triggeredBy: data.user.email,
    to,
    fromAddress,
    hasApiKey,
    note: "This test uses the LIVE customer_form_templates config — edits at /dashboard/settings/templates take effect immediately on the next test.",
    result,
  }, { status: result.ok ? 200 : 500 });
}
