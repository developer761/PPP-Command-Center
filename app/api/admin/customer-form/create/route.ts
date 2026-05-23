import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { getProfileByUserId } from "@/lib/auth/profile";
import { isAdminEmail } from "@/lib/auth/admin";
import { createToken, markSent } from "@/lib/customer-form/tokens";
import { sendCustomerFormInvite } from "@/lib/email/resend";
import { loadFormRenderData } from "@/lib/customer-form/render-data";

/**
 * Admin "Send Color Form" handler.
 *
 *   POST /api/admin/customer-form/create
 *   body: {
 *     workOrderId: string,
 *     customerEmail: string,
 *     customerName?: string,
 *     subjectOverride?: string,
 *     introOverride?: string,
 *   }
 *
 * Steps:
 *   1. Auth — admin only
 *   2. Validate input — email shape + WO exists in SF
 *   3. Create token row in Supabase (30-day expiry)
 *   4. Send invitation email via Resend
 *   5. Mark sent_at + delivery_status on the token row
 *   6. Return { token, formUrl, resendMessageId }
 */

export async function POST(request: Request) {
  // 1. Auth
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

  // 2. Validate input
  let body: {
    workOrderId?: string;
    customerEmail?: string;
    customerName?: string;
    subjectOverride?: string;
    introOverride?: string;
  };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "bad_json" }, { status: 400 });
  }

  const workOrderId = body.workOrderId?.trim();
  const customerEmail = body.customerEmail?.trim().toLowerCase();
  if (!workOrderId || !/^0WO/.test(workOrderId)) {
    return NextResponse.json({ error: "invalid_work_order_id" }, { status: 400 });
  }
  if (!customerEmail || !/^[a-z0-9._+\-]+@[a-z0-9.\-]+$/i.test(customerEmail)) {
    return NextResponse.json({ error: "invalid_customer_email" }, { status: 400 });
  }

  // 3. Confirm the WO exists in SF + capture account name for the token row
  const wo = await loadFormRenderData(workOrderId);
  if (!wo) {
    return NextResponse.json({ error: "wo_not_found_in_sf" }, { status: 404 });
  }

  const customerName = body.customerName?.trim() || wo.accountName || null;

  // 4. Create token
  const tokenResult = await createToken({
    work_order_id: workOrderId,
    work_order_number: wo.workOrderNumber,
    customer_email: customerEmail,
    customer_name: customerName,
    created_by_user_id: data.user.id,
  });
  if ("error" in tokenResult) {
    return NextResponse.json({ error: "token_create_failed", message: tokenResult.error }, { status: 500 });
  }
  const token = tokenResult.token;

  // Build the customer-facing form URL. NEXT_PUBLIC_APP_URL must be set in
  // Vercel env (https://hub.precisionpaintingplus.net for prod).
  const baseUrl =
    process.env.NEXT_PUBLIC_APP_URL?.replace(/\/$/, "") ||
    new URL(request.url).origin;
  const formUrl = `${baseUrl}/select/${token}`;

  // 5. Send the invitation email
  const send = await sendCustomerFormInvite({
    to: customerEmail,
    customerName,
    workOrderNumber: wo.workOrderNumber,
    formUrl,
    subjectOverride: body.subjectOverride,
    introOverride: body.introOverride,
  });

  if (!send.ok) {
    // Token's already created — don't roll it back, admin can retry sending.
    // Return the token + url so the admin can copy/paste manually if Resend
    // is having a bad day.
    return NextResponse.json({
      ok: false,
      error: "email_send_failed",
      message: send.error,
      token,
      formUrl,
    }, { status: 502 });
  }

  // 6. Mark sent
  await markSent(token, "delivered");

  return NextResponse.json({
    ok: true,
    token,
    formUrl,
    resendMessageId: send.id,
    customerEmail,
    customerName,
    workOrderNumber: wo.workOrderNumber,
  });
}
