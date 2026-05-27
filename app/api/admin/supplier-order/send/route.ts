import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { getProfileByUserId } from "@/lib/auth/profile";
import { isAdminEmail } from "@/lib/auth/admin";
import { sendEmail } from "@/lib/email/resend";
import { createClient as createSupabaseAdminClient } from "@supabase/supabase-js";

/**
 * Sends a supplier order via Resend + persists a `supplier_orders` row.
 *
 *   POST /api/admin/supplier-order/send
 *   body: {
 *     workOrderId: string,
 *     workOrderNumber: string | null,
 *     supplierAccountId: string,
 *     supplierName: string,
 *     poNumber: string,                 — from /draft endpoint
 *     subject: string,                  — admin-edited (final)
 *     body: string,                     — admin-edited (final)
 *     sentToEmail: string,              — required to send
 *     fulfillmentMethod: 'delivery'|'pickup',
 *     deliveryAddress?: object,         — { name, street, city, state, postalCode, source }
 *     pickupLocation?: string,
 *     requiredByDate?: string,          — ISO date
 *     lineItems: array,                 — from the draft (snapshot at send time)
 *     extras?: array,                   — from the draft
 *     specialInstructions?: string,
 *   }
 *
 * Idempotency: a UNIQUE (work_order_id, supplier_account_id) WHERE status='draft'
 * index in the DB prevents two open drafts. On a successful send we transition
 * the existing draft row to status='sent' (or insert a new sent row if no
 * draft exists). Concurrent sends race to the UNIQUE constraint; the loser
 * gets a clean 409 response.
 *
 * Admin-only.
 */
export async function POST(request: Request) {
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

  let body: {
    workOrderId?: string;
    workOrderNumber?: string | null;
    supplierAccountId?: string;
    supplierName?: string;
    poNumber?: string;
    subject?: string;
    body?: string;
    sentToEmail?: string;
    fulfillmentMethod?: "delivery" | "pickup";
    deliveryAddress?: unknown;
    pickupLocation?: string;
    requiredByDate?: string;
    lineItems?: unknown[];
    extras?: unknown[];
    specialInstructions?: string;
  };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "bad_json" }, { status: 400 });
  }

  // Required-field validation. We're strict here because once an email goes
  // out to a supplier it can't be unsent.
  const missing: string[] = [];
  if (!body.workOrderId) missing.push("workOrderId");
  if (!body.supplierAccountId) missing.push("supplierAccountId");
  if (!body.supplierName) missing.push("supplierName");
  if (!body.poNumber) missing.push("poNumber");
  if (!body.subject?.trim()) missing.push("subject");
  if (!body.body?.trim()) missing.push("body");
  if (!body.sentToEmail?.trim()) missing.push("sentToEmail");
  if (!body.fulfillmentMethod) missing.push("fulfillmentMethod");
  if (!Array.isArray(body.lineItems)) missing.push("lineItems");
  if (missing.length > 0) {
    return NextResponse.json({ error: "missing_fields", missing }, { status: 400 });
  }

  // Email-shape validation — paranoid because we're about to send to it.
  if (!/^[a-z0-9._+\-]+@[a-z0-9.\-]+\.[a-z]{2,}$/i.test(body.sentToEmail!.trim())) {
    return NextResponse.json({ error: "invalid_supplier_email" }, { status: 400 });
  }

  const sbAdmin = createSupabaseAdminClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SECRET_KEY!,
    { auth: { persistSession: false, autoRefreshToken: false } }
  );

  // Step 1: Try to UPDATE an existing draft row (admin's draft transitions
  // to sent). If no draft exists yet, INSERT a new row.
  //
  // CRITICAL: we DON'T stamp sent_at here yet — that happens in Step 3 only
  // after Resend confirms delivery. Previous behavior stamped sent_at before
  // calling Resend, so a failed send left a row marked status='failed' with
  // a misleading sent_at timestamp (suggesting "we tried to send at exactly
  // 3:42:17" when the email never actually went out). The row is created
  // with status='sent' for the optimistic path; if Step 2 fails we flip to
  // 'failed' AND clear sent_at, leaving a clean audit trail.
  const draftLookup = await sbAdmin
    .from("supplier_orders")
    .select("id, status")
    .eq("work_order_id", body.workOrderId!)
    .eq("supplier_account_id", body.supplierAccountId!)
    .eq("status", "draft")
    .maybeSingle();

  let supplierOrderId: string;
  if (draftLookup.data?.id) {
    // Update the draft row in place — keeps the original created_at + audit chain
    const upd = await sbAdmin
      .from("supplier_orders")
      .update({
        work_order_number: body.workOrderNumber ?? null,
        supplier_name: body.supplierName!,
        po_number: body.poNumber!,
        draft_body: body.body!,
        special_instructions: body.specialInstructions ?? null,
        fulfillment_method: body.fulfillmentMethod!,
        delivery_address: body.deliveryAddress ?? null,
        pickup_location: body.pickupLocation ?? null,
        required_by_date: body.requiredByDate ?? null,
        line_items: body.lineItems!,
        extras: body.extras ?? [],
        sent_to_email: body.sentToEmail!.trim().toLowerCase(),
        status: "sent",
        created_by_user_id: data.user.id,
      })
      .eq("id", draftLookup.data.id)
      .select("id")
      .single();
    if (upd.error) {
      return NextResponse.json({ error: "draft_update_failed", message: upd.error.message }, { status: 500 });
    }
    supplierOrderId = upd.data!.id;
  } else {
    const ins = await sbAdmin
      .from("supplier_orders")
      .insert({
        work_order_id: body.workOrderId!,
        work_order_number: body.workOrderNumber ?? null,
        supplier_account_id: body.supplierAccountId!,
        supplier_name: body.supplierName!,
        po_number: body.poNumber!,
        draft_body: body.body!,
        special_instructions: body.specialInstructions ?? null,
        fulfillment_method: body.fulfillmentMethod!,
        delivery_address: body.deliveryAddress ?? null,
        pickup_location: body.pickupLocation ?? null,
        required_by_date: body.requiredByDate ?? null,
        line_items: body.lineItems!,
        extras: body.extras ?? [],
        sent_to_email: body.sentToEmail!.trim().toLowerCase(),
        status: "sent",
        created_by_user_id: data.user.id,
      })
      .select("id")
      .single();
    if (ins.error) {
      // 23505 = unique_violation — could be PO collision OR the "one open
      // draft per (wo, supplier)" partial-unique kicking in if another admin
      // raced us. Return 409 so the UI tells the admin to refresh.
      if (ins.error.code === "23505") {
        return NextResponse.json({
          error: "duplicate_order",
          message: "Another admin sent this order or a draft already exists. Refresh + retry.",
        }, { status: 409 });
      }
      return NextResponse.json({ error: "insert_failed", message: ins.error.message }, { status: 500 });
    }
    supplierOrderId = ins.data!.id;
  }

  // Step 2: Fire the Resend send. ReplyTo = orders@orders.precisionpaintingplus.net
  // so the supplier's response goes to PPP's branded inbox (configured to be
  // ingested by the upcoming /dashboard/inbox via Resend inbound webhook).
  const send = await sendEmail({
    to: body.sentToEmail!.trim().toLowerCase(),
    subject: body.subject!,
    text: body.body!,
    replyTo: process.env.RESEND_FROM_ADDRESS || undefined,
    tags: [
      { name: "kind", value: "supplier_order" },
      { name: "po", value: body.poNumber! },
      { name: "supplier", value: body.supplierAccountId!.slice(0, 18) },
    ],
  });

  if (!send.ok) {
    // Mark the row failed so admin can retry from the UI; don't roll back —
    // the audit trail is more useful than a clean slate. Leave sent_at NULL
    // so the row is unambiguously "never delivered" rather than carrying a
    // misleading "tried to send at exactly 3:42:17" timestamp.
    await sbAdmin
      .from("supplier_orders")
      .update({
        status: "failed",
        failure_reason: send.error.slice(0, 1000),
        sent_at: null,
      })
      .eq("id", supplierOrderId);
    return NextResponse.json({
      ok: false,
      error: "email_send_failed",
      message: send.error,
      supplierOrderId,
    }, { status: 502 });
  }

  // Step 3: Stamp sent_at + resend_message_id ONLY after Resend confirmed
  // delivery. The id lets the inbound webhook thread the supplier's future
  // reply back to this order. If this update fails the email itself went
  // out (admin needs to know) but threading may break — we surface that as
  // a soft warning, not a hard failure.
  let messageIdUpdateOk = true;
  let messageIdUpdateError: string | null = null;
  const { error: msgIdErr } = await sbAdmin
    .from("supplier_orders")
    .update({
      sent_at: new Date().toISOString(),
      resend_message_id: send.id,
    })
    .eq("id", supplierOrderId);
  if (msgIdErr) {
    messageIdUpdateOk = false;
    messageIdUpdateError = msgIdErr.message;
    console.error(
      `[supplier-order/send] failed to stamp resend_message_id ${send.id} on order ${supplierOrderId}: ${msgIdErr.message}. Replies from this supplier will land in the unmatched inbox bucket.`
    );
  }

  return NextResponse.json({
    ok: true,
    supplierOrderId,
    poNumber: body.poNumber,
    sentToEmail: body.sentToEmail!.trim().toLowerCase(),
    resendMessageId: send.id,
    // Soft warning surface — when this is false, future replies from the
    // supplier may not thread back to this order in the inbox. Email send
    // itself succeeded.
    replyThreadingOk: messageIdUpdateOk,
    replyThreadingError: messageIdUpdateError,
  });
}
