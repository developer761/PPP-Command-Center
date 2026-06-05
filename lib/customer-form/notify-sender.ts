import "server-only";

import { createClient as createSupabaseAdminClient } from "@supabase/supabase-js";
import { sendEmail } from "@/lib/email/resend";

/**
 * Notify the admin who originally sent a customer form when the customer
 * submits (or re-edits) it. Katie 2026-06-05: "When the customer submits
 * a form, can the sender also be notified of a submission so they know
 * that they need to review what the customer sent?"
 *
 * Fire-and-forget — the customer's success response shouldn't depend on
 * the notification email succeeding. Every failure path logs + returns.
 *
 * Recipient lookup chain:
 *   1. profiles table by user_id → email (preferred — same record we use
 *      for the rest of the auth flow)
 *   2. Supabase auth users by user_id (fallback if profiles row missing)
 *   3. Skip entirely (log) if neither resolves
 *
 * Recipient guard: only PPP-domain addresses get the notification. Karan's
 * gmail-only admin login gets skipped — he can pull up Mail Hub directly.
 */

type NotifyInput = {
  adminUserId: string;
  customerName: string | null;
  workOrderNumber: string | null;
  workOrderId: string;
  isReedit: boolean;
  lineItemCount: number;
  orderAlreadyPlaced: boolean;
};

function adminClient() {
  return createSupabaseAdminClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SECRET_KEY!,
    { auth: { persistSession: false, autoRefreshToken: false } }
  );
}

/** Resolve the admin's email. Best-effort; returns null on any failure path. */
async function resolveAdminEmail(adminUserId: string): Promise<string | null> {
  try {
    const sb = adminClient();
    // Profiles table is the canonical place. Falls back to auth admin API
    // only when the profile row is missing (rare — every login upserts it).
    const { data: profile } = await sb
      .from("profiles")
      .select("email")
      .eq("user_id", adminUserId)
      .maybeSingle();
    const profileEmail = profile?.email as string | undefined;
    if (profileEmail) return profileEmail.toLowerCase();
    // Fallback: auth admin API. Costs an extra round-trip but is rare.
    const { data, error } = await sb.auth.admin.getUserById(adminUserId);
    if (error) {
      console.warn("[notify-sender] auth.admin.getUserById failed:", error.message);
      return null;
    }
    return data?.user?.email?.toLowerCase() ?? null;
  } catch (err) {
    console.warn("[notify-sender] resolveAdminEmail threw:", err instanceof Error ? err.message : err);
    return null;
  }
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export async function notifySenderOnSubmit(input: NotifyInput): Promise<void> {
  const adminEmail = await resolveAdminEmail(input.adminUserId);
  if (!adminEmail) {
    console.log(`[notify-sender] skipping — no email resolvable for user ${input.adminUserId.slice(0, 8)}…`);
    return;
  }
  // PPP-domain guard. Karan's gmail-only admin login → skip silently (he
  // sees customer submissions in Mail Hub already).
  if (
    !adminEmail.endsWith("@precisionpaintingplus.com") &&
    !adminEmail.endsWith("@precisionpaintingplus.net")
  ) {
    console.log(`[notify-sender] skipping non-PPP-domain admin email ${adminEmail}`);
    return;
  }

  const customer = input.customerName?.trim() || "the customer";
  const woLabel = input.workOrderNumber ? `WO #${input.workOrderNumber}` : "the work order";
  const verb = input.isReedit ? "UPDATED their colors" : "submitted their colors";
  const subject = input.isReedit
    ? `Colors updated for ${customer} — ${woLabel}`
    : `Colors submitted for ${customer} — ${woLabel}`;

  // App URL for deep-linking back into materials → this specific WO.
  const baseUrl =
    process.env.NEXT_PUBLIC_APP_URL?.replace(/\/$/, "") || "https://hub.precisionpaintingplus.net";
  const materialsUrl = `${baseUrl}/dashboard/materials?wo=${encodeURIComponent(input.workOrderId)}`;

  const orderWarning = input.orderAlreadyPlaced && input.isReedit
    ? "\n\n⚠ HEADS-UP: The supplier order for this WO already went out — the customer changed colors AFTER materials were ordered. You may need to reach out to the supplier to amend the order, or reach out to the customer to confirm they understand the timing."
    : "";

  const text = [
    `${customer} ${verb}${input.workOrderNumber ? ` for WO #${input.workOrderNumber}` : ""}.`,
    "",
    `${input.lineItemCount} room${input.lineItemCount === 1 ? "" : "s"} on this submission.`,
    orderWarning,
    "",
    "Open in Command Center:",
    materialsUrl,
    "",
    "— PPP Command Center",
  ].join("\n").trim();

  const orderWarningHtml = input.orderAlreadyPlaced && input.isReedit
    ? `<p style="margin:12px 0 0 0; padding:10px; background:#fff4e5; border-left:3px solid #d35400; color:#7a3a00;">
        <strong>⚠ HEADS-UP:</strong> the supplier order for this WO already went out — the customer changed colors <em>after</em> materials were ordered. You may need to contact the supplier to amend the order.
      </p>`
    : "";

  const html = `<table border="0" cellpadding="0" cellspacing="0" style="width:600px; font-family:tahoma,geneva,sans-serif; font-size:11pt; line-height:1.5; color:#333;">
  <tbody>
    <tr>
      <td style="padding:18px 20px 12px 20px;">
        <p style="margin:0; font-size:13pt; font-weight:bold; color:#0a0e17;">
          ${escapeHtml(customer)} ${input.isReedit ? "updated their colors" : "submitted their colors"}
        </p>
        ${input.workOrderNumber ? `<p style="margin:4px 0 0 0; color:#666; font-size:10pt;">WO #${escapeHtml(input.workOrderNumber)} · ${input.lineItemCount} room${input.lineItemCount === 1 ? "" : "s"}</p>` : `<p style="margin:4px 0 0 0; color:#666; font-size:10pt;">${input.lineItemCount} room${input.lineItemCount === 1 ? "" : "s"} on this submission</p>`}
        ${orderWarningHtml}
      </td>
    </tr>
    <tr>
      <td style="padding:8px 20px 18px 20px;">
        <a href="${encodeURI(materialsUrl)}" style="display:inline-block; padding:10px 22px; background-color:#2563eb; color:#ffffff; text-decoration:none; font-weight:bold; font-size:11pt; border-radius:4px;">
          Open in Command Center
        </a>
      </td>
    </tr>
    <tr>
      <td style="padding:0 20px 18px 20px; border-top:1px solid #eee;">
        <p style="margin:12px 0 0 0; font-size:9pt; color:#999;">
          Sent automatically because you originally sent the color form to this customer.
        </p>
      </td>
    </tr>
  </tbody>
</table>`;

  await sendEmail({
    to: adminEmail,
    subject,
    text,
    html,
    tags: [
      { name: "kind", value: "customer_form_notify_sender" },
      ...(input.workOrderNumber ? [{ name: "wo", value: input.workOrderNumber }] : []),
    ],
  });
}
