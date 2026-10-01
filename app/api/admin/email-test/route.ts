import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { getProfileByUserId } from "@/lib/auth/profile";
import { isAdminEmail } from "@/lib/auth/admin";
import { sendCustomerFormInvite, sendCustomerFormConfirmation } from "@/lib/email/resend";
import { buildReceiptRooms } from "@/lib/customer-form/receipt-lines";


/**
 * Never cached. Admin surfaces read live database and Salesforce state, and a
 * cached response here is not a stale dashboard — it is a save that appears not
 * to have worked. Kate hit exactly that on Settings > Suppliers: unchecking
 * "Active" wrote correctly and the refresh handed back the pre-save list, so
 * the change looked lost when it was already in the database.
 */
export const dynamic = "force-dynamic";

/**
 * Admin-only test endpoint that fires a sample customer-form invite email
 * to the supplied address — using the CURRENT customer_form_templates
 * config so admin can verify their template edits actually took effect.
 *
 *   GET /api/admin/email-test?to=karan@example.com
 *      Optional: ?name=Jane%20Doe  &wo=00012345
 *      Optional: ?kind=confirmation  — preview the submission RECEIPT
 *                (Kate 2026-10-01) instead of the invite. Default: invite.
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
  // New York, not the server's clock. Vercel runs UTC, so this read "4:19 PM"
  // to somebody looking at it at 12:19 — which makes the stamp useless for the
  // one job it has, telling two test emails apart. PPP is on Long Island and
  // every other customer-facing time in this app is already Eastern.
  const stamp = new Date().toLocaleString("en-US", {
    hour: "numeric",
    minute: "2-digit",
    timeZone: "America/New_York",
  });

  // Which of the two customer emails to preview. The receipt (Kate
  // 2026-10-01) needs this just as much as the invite did: it is only sent
  // by a real form submission, so without a test path the only way to see
  // one was to submit somebody's live work order.
  const kind = (url.searchParams.get("kind") || "invite").toLowerCase();
  if (kind !== "invite" && kind !== "confirmation") {
    return NextResponse.json({
      error: "unknown_kind",
      hint: "Use ?kind=invite (default) or ?kind=confirmation",
    }, { status: 400 });
  }

  // Sample selections, built through the SAME function a real submission
  // uses, so the preview cannot drift from the real receipt. Deliberately
  // includes the awkward rows — a skipped surface, a color with no finish,
  // and a surface left blank — because those are the lines worth checking.
  const result = kind === "confirmation"
    ? await sendCustomerFormConfirmation({
        to,
        customerName: fakeName,
        workOrderNumber: fakeWoNumber,
        formUrl: fakeFormUrl,
        rooms: buildReceiptRooms({
          lineItems: [
            {
              id: "sample-1",
              surfaces: [
                { surface: "Walls", colorName: "Stardust", colorCode: "2108-40", finish: "Satin" },
                { surface: "Ceiling", colorName: "Chantilly Lace", colorCode: "OC-65", finish: null },
                { surface: "Trim", skipped: true },
              ],
              notes: "Sample room note",
            },
            {
              id: "sample-2",
              surfaces: [{ surface: "Walls", colorName: null }],
              notes: null,
            },
          ],
          roomLabelById: new Map([
            ["sample-1", `[TEST ${stamp}] Interior Painting · Bathroom`],
            ["sample-2", "[TEST] Interior Painting · Living Room"],
          ]),
        }),
        globalNotes: "Sample job-wide note — this is a template preview, not a real submission.",
      })
    // Use the REAL customer-form invite path so admin sees their template
    // edits reflected. Prepend "[TEST]" via subjectOverride so the email
    // reads as a preview, not a live customer send.
    : await sendCustomerFormInvite({
        to,
        customerName: fakeName,
        workOrderNumber: fakeWoNumber,
        formUrl: fakeFormUrl,
        subjectOverride: `[TEST] Template preview · ${stamp}`,
      });

  return NextResponse.json({
    triggeredBy: data.user.email,
    kind,
    to,
    fromAddress,
    hasApiKey,
    note: "This test uses the LIVE customer_form_templates config — edits at /dashboard/settings/templates take effect immediately on the next test.",
    hint: kind === "invite" ? "Add &kind=confirmation to preview the submission receipt instead." : undefined,
    result,
  }, { status: result.ok ? 200 : 500 });
}
