import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { getProfileByUserId } from "@/lib/auth/profile";
import { isAdminEmail } from "@/lib/auth/admin";
import { createToken, markSent } from "@/lib/customer-form/tokens";
import { sendCustomerFormInvite } from "@/lib/email/resend";
import { loadFormRenderData } from "@/lib/customer-form/render-data";
import { getSalesforceClient } from "@/lib/salesforce/client";

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

/**
 * Form link expiry = 24h before the scheduled job start.
 *   - No scheduled date → 30-day default.
 *   - Cutoff already past / under 48h away (form sent late) → floor to the
 *     LATER of the start date itself or 48h from now, so a late send never
 *     produces an already-dead link.
 */
function computeFormExpiry(scheduledStart: string | null): string {
  const DAY = 86_400_000;
  const now = Date.now();
  if (!scheduledStart) return new Date(now + 30 * DAY).toISOString();
  // A date-only value (e.g. Opportunity.CloseDate "2026-06-15", used as the
  // last-resort start anchor) parses as MIDNIGHT UTC — which is the prior
  // evening on the US East Coast, so "start − 24h" would kill the link ~28h
  // early. PPP operates Eastern, so anchor a date-only start to noon Eastern
  // (≈17:00Z) before subtracting 24h. Real datetime starts (WorkOrder.StartDate)
  // already carry a zone and are parsed as-is. The ≤1h EST/EDT drift is
  // immaterial next to the full-day error it replaces.
  const anchored = /^\d{4}-\d{2}-\d{2}$/.test(scheduledStart)
    ? `${scheduledStart}T12:00:00-05:00`
    : scheduledStart;
  const start = new Date(anchored).getTime();
  if (isNaN(start)) return new Date(now + 30 * DAY).toISOString();
  const cutoff = start - DAY; // 24h before start
  const floor = now + 2 * DAY; // never less than 48h of usable time
  if (cutoff < floor) return new Date(Math.max(start, floor)).toISOString();
  return new Date(cutoff).toISOString();
}

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
  // Email regex aligned with the supplier-side check — requires a TLD so we
  // don't accept "user@domain" (Resend would silently reject and admin would
  // think the customer was emailed when the form invite never sent).
  if (!customerEmail || !/^[a-z0-9._+\-]+@[a-z0-9.\-]+\.[a-z]{2,}$/i.test(customerEmail)) {
    // Friendlier message for the admin UI so workers know what's wrong without
    // reading the error code (the regex requires a TLD — "user@domain"
    // without "." rejects; Resend would silently swallow such addresses).
    return NextResponse.json({
      error: "invalid_customer_email",
      message: "That email doesn't look right — check that it has an @ and a domain (e.g., name@example.com).",
    }, { status: 400 });
  }

  // 3. Confirm the WO exists in SF + capture account name for the token row
  const wo = await loadFormRenderData(workOrderId);
  if (!wo) {
    return NextResponse.json({ error: "wo_not_found_in_sf" }, { status: 404 });
  }

  const customerName = body.customerName?.trim() || wo.accountName || null;

  // 4. Create token — expires 24h before the scheduled job start (Katie
  // 2026-05-29). The anchor is StartDate → DesiredStart__c → CloseDate. If
  // that cutoff is already past or <48h out (form sent late), floor it so we
  // never create a dead link; no scheduled date at all → 30-day default.
  const tokenResult = await createToken({
    work_order_id: workOrderId,
    work_order_number: wo.workOrderNumber,
    customer_email: customerEmail,
    customer_name: customerName,
    created_by_user_id: data.user.id,
    expiresAt: computeFormExpiry(wo.scheduledStart),
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

  // Sender context — Katie 2026-06-05: CC the sender + show their phone
  // so the customer knows who to call. Pulls MobilePhone (preferred — direct
  // line) → Phone (desk) from SF User. Skips entirely when admin isn't
  // mapped to an SF user (e.g., Karan's gmail-only admin login). Best-effort:
  // any SF blip just omits the phone, never blocks the send.
  const senderEmail: string | null = data.user.email?.toLowerCase() ?? null;
  let senderName: string | null = profile?.sf_user_name ?? null;
  let senderPhone: string | null = null;
  if (profile?.sf_user_id) {
    try {
      const conn = await getSalesforceClient();
      const idEsc = profile.sf_user_id.replace(/'/g, "\\'");
      const userResult = await conn.query<Record<string, unknown>>(
        `SELECT MobilePhone, Phone, Name FROM User WHERE Id = '${idEsc}' LIMIT 1`
      );
      const row = userResult.records[0];
      if (row) {
        const mob = typeof row.MobilePhone === "string" ? row.MobilePhone.trim() : "";
        const ph = typeof row.Phone === "string" ? row.Phone.trim() : "";
        senderPhone = mob || ph || null;
        if (!senderName && typeof row.Name === "string") senderName = row.Name;
      }
    } catch (err) {
      console.warn("[customer-form/create] couldn't fetch sender phone from SF:", err instanceof Error ? err.message : err);
    }
  }
  // Domain guard: only PPP-owned domains can be CC'd (defense in depth — the
  // resend wrapper enforces the same rule but a missed env override here
  // would silently leak admin gmail addresses to customer threads).
  const ccEmail = senderEmail && (senderEmail.endsWith("@precisionpaintingplus.com") || senderEmail.endsWith("@precisionpaintingplus.net"))
    ? senderEmail
    : null;

  // 5. Send the invitation email
  const send = await sendCustomerFormInvite({
    to: customerEmail,
    customerName,
    workOrderNumber: wo.workOrderNumber,
    formUrl,
    subjectOverride: body.subjectOverride,
    introOverride: body.introOverride,
    senderEmail: ccEmail,
    senderName,
    senderPhone,
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

  // 6. Mark SENT (not "delivered" — Resend's 200 means accepted, not
  // delivered) + capture the Resend message id so the events webhook can
  // promote delivery_status to delivered/opened/bounced on this same row.
  await markSent(token, "sent", send.id ?? undefined);

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
