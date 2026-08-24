import { isCompanyEmail } from "@/lib/auth/company-domain";
import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { nextPoNumber } from "@/lib/supplier-order/builder";
import { getProfileByUserId } from "@/lib/auth/profile";
import { isAdminEmail } from "@/lib/auth/admin";
import { capabilitiesFor, normalizeRole } from "@/lib/auth/roles";
import { sendEmail } from "@/lib/email/resend";
import { createClient as createSupabaseAdminClient } from "@supabase/supabase-js";
import { VALID_MATERIAL_TYPE_VALUES } from "@/lib/customer-form/material-types";

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
  try {
  const supabase = await createClient();
  const { data } = await supabase.auth.getUser();
  if (!data?.user) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const profile = await getProfileByUserId(data.user.id);
  // Deactivated accounts lose API access immediately (bootstrap admins exempt).
  if (profile && profile.is_active === false && !isAdminEmail(data.user.email)) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  // Role-derived capability (consistent with the UI + customer-form routes),
  // not the legacy is_admin flag.
  const isAdmin = capabilitiesFor(
    normalizeRole(profile?.role, profile?.is_admin ?? isAdminEmail(data.user.email))
  ).canOrderMaterials;
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
    // Per-color Material Type overrides — already baked into `body` at draft
    // time by the modal. Carried through here so a future refactor that
    // rebuilds the body server-side (e.g. for an audit replay or a resend
    // with regenerated layout) doesn't silently drop the overrides.
    // Audit 2026-06-05 — regression scan flagged the type contract gap.
    materialTypeOverrides?: Record<string, string>;
  };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "bad_json" }, { status: 400 });
  }

  // Required-field validation. We're strict here because once an email goes
  // out to a supplier it can't be unsent.
  //
  // General Supplies relaxes ONE constraint: lineItems can be empty (the
  // whole point is "order extras with no paint colors"). Everything else
  // is required — sentToEmail / subject / body / extras still all need
  // to be set since the email is real and goes to a real recipient.
  const isGeneral = body.supplierAccountId === "__general__";
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
  // General Supplies must have at least one extra OR special instructions —
  // otherwise the email body is just "Hi, here's an order: (nothing). Thanks."
  // which makes no sense. Real supplier orders can be paint-only.
  if (isGeneral) {
    const hasExtras = Array.isArray(body.extras) && body.extras.length > 0;
    const hasInstructions = !!body.specialInstructions?.trim();
    if (!hasExtras && !hasInstructions) {
      return NextResponse.json({
        error: "general_supplies_empty",
        message: "Pick at least one item or add special instructions before sending a General Supplies order.",
      }, { status: 400 });
    }
  }

  // Email-shape validation — paranoid because we're about to send to it.
  if (!/^[a-z0-9._+\-]+@[a-z0-9.\-]+\.[a-z]{2,}$/i.test(body.sentToEmail!.trim())) {
    return NextResponse.json({ error: "invalid_supplier_email" }, { status: 400 });
  }

  // materialTypeOverrides validation — defensive, mirrors the customer-form
  // submit route's allowlist. Without this, an admin (or a tampered client)
  // could push a fake product name like "Fake Paint" into the supplier email
  // + audit trail. Catch unknown values before they leak to the vendor.
  // Audit 2026-06-07.
  if (body.materialTypeOverrides && typeof body.materialTypeOverrides === "object") {
    const invalid: string[] = [];
    for (const [colorKey, mt] of Object.entries(body.materialTypeOverrides)) {
      if (typeof mt !== "string") continue;
      if (!mt.trim()) continue; // empty = cleared, no-op (handled at builder)
      if (!VALID_MATERIAL_TYPE_VALUES.has(mt)) {
        invalid.push(`${colorKey}=${mt}`);
      }
    }
    if (invalid.length > 0) {
      return NextResponse.json({
        error: "invalid_material_type_override",
        message: `Unknown Material Type value(s): ${invalid.join(", ")}. Pick from the dropdown.`,
        invalid,
      }, { status: 400 });
    }
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
        delivery_status: "sent",
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
    // One definition, used by the initial insert and the PO-collision retry —
    // two copies would drift and the retry would quietly store a different row.
    const orderRow = {
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
        // Initial delivery_status — webhook will update to delivered/bounced/etc.
        // when events fire. Without this default, rows sit at NULL forever if
        // events webhook isn't configured, making them indistinguishable from
        // "waiting for first event."
        delivery_status: "sent",
        created_by_user_id: data.user.id,
    };
    const ins = await sbAdmin
      .from("supplier_orders")
      .insert(orderRow)
      .select("id")
      .single();
    let insData = ins.data;
    if (ins.error) {
      // 23505 = unique_violation. Two very different causes, and the old code
      // treated both as "refresh and retry":
      //
      //   (a) po_number collision — the PO was computed when the draft was
      //       built, so it can be stale by the time Send is pressed, and
      //       before R5.6 it could be a number a cancelled order still held.
      //       Telling the admin to refresh was useless there: the recomputed
      //       number was identical every time, so the work order was bricked.
      //   (b) the "one open draft per (wo, supplier)" partial-unique — that IS
      //       a real concurrent-admin conflict and refreshing is the answer.
      //
      // (a) is recoverable without the admin doing anything, so recover: take
      // a freshly-computed PO and insert once more. Only (b) reaches the 409.
      const isPoCollision = /po_number/i.test(ins.error.message ?? "");
      if (ins.error.code === "23505" && isPoCollision) {
        const freshPo = await nextPoNumber(body.workOrderId!, body.workOrderNumber ?? "");
        console.warn(
          `[supplier-order/send] PO ${body.poNumber} was taken; retrying as ${freshPo}`
        );
        const retry = await sbAdmin
          .from("supplier_orders")
          .insert({ ...orderRow, po_number: freshPo })
          .select("id")
          .single();
        if (retry.error) {
          return NextResponse.json({
            error: "duplicate_order",
            message: "Couldn't allocate a PO number for this order. Refresh and try again.",
          }, { status: 409 });
        }
        // The email must carry the number that actually got stored, or the
        // vendor quotes a PO the Command Center has never heard of. The PO
        // appears in the subject AND in the rendered body ("PO Number: …"),
        // and both were composed against the stale one — so rewrite the text
        // too, not just the column. A row saying -2 under an email saying -1
        // is the same defect one layer down.
        const stalePo = body.poNumber!;
        const swap = (t: string | undefined) =>
          t ? t.split(stalePo).join(freshPo) : t;
        body.subject = swap(body.subject);
        body.body = swap(body.body);
        body.poNumber = freshPo;
        // Persist the rewritten copy, or Mail Hub renders the stale text.
        await sbAdmin
          .from("supplier_orders")
          .update({ draft_body: body.body! })
          .eq("id", retry.data!.id);
        insData = retry.data;
      } else if (ins.error.code === "23505") {
        return NextResponse.json({
          error: "duplicate_order",
          message: "Another admin is already working on an order for this work order and supplier. Refresh and try again.",
        }, { status: 409 });
      } else {
        return NextResponse.json({ error: "insert_failed", message: ins.error.message }, { status: 500 });
      }
    }
    supplierOrderId = insData!.id;
  }

  // Step 2: Fire the Resend send. ReplyTo = orders@orders.precisionpaintingplus.net
  // so the supplier's response goes to PPP's branded inbox (configured to be
  // ingested by the upcoming /dashboard/inbox via Resend inbound webhook).
  // RESEND_FROM_ADDRESS is the reply-to that routes supplier responses back
  // into our inbox. Without it, supplier replies go to the orders@ Gmail
  // and never appear in /dashboard/inbox — admin assumes "no reply yet"
  // when the supplier already responded. Log loudly so this gets noticed
  // in production logs even though we can't refuse to send (the order is
  // already drafted; admin clicked Send).
  const replyTo = process.env.RESEND_FROM_ADDRESS;
  if (!replyTo) {
    console.error(
      `[supplier-order/send] RESEND_FROM_ADDRESS env var not set — supplier replies for PO ${body.poNumber} will NOT thread back to the inbox. Set it in Vercel.`
    );
  }
  // CC the requester (the admin who clicked Send) so supplier replies hit
  // their inbox too — Katie 2026-06-03: "replies go to the command center
  // but also CC the requester's email." Replies still flow into the Mail
  // Hub via the reply-to address; CC just gives the originating admin a
  // direct copy in their personal inbox.
  //
  // Restricted to PPP-owned domains: Karan/Claude admin accounts sign in
  // as @gmail.com to test, but we don't want their personal email leaking
  // into the vendor's CC header on production orders. Configurable via
  // env COMPANY_EMAIL_DOMAINS (same list the customer-email lookup uses).
  const requesterEmail = (data.user.email ?? "").trim().toLowerCase();
  const supplierEmail = body.sentToEmail!.trim().toLowerCase();
  // Shared with the draft route (R4.29) so the address printed in the email's
  // questions block and the address actually CC'd can never disagree — telling
  // a vendor to write to someone who isn't on the thread is worse than not
  // naming anyone.
  const isPppEmail = isCompanyEmail;
  const ccList: string[] = [];
  if (
    requesterEmail &&
    requesterEmail.includes("@") &&
    requesterEmail !== supplierEmail &&
    isPppEmail(requesterEmail)
  ) {
    ccList.push(requesterEmail);
  } else if (requesterEmail && requesterEmail.includes("@") && !isPppEmail(requesterEmail)) {
    console.log(`[supplier-order/send] requester ${requesterEmail.replace(/(.{2}).*@/, "$1***@")} is not a PPP domain — skipping CC to keep personal inbox out of vendor headers`);
  }
  const send = await sendEmail({
    to: supplierEmail,
    subject: body.subject!,
    text: body.body!,
    replyTo: replyTo || undefined,
    cc: ccList.length > 0 ? ccList : undefined,
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
  } catch (err) {
    console.error("[supplier-order/send POST] unhandled:", err);
    return NextResponse.json(
      { ok: false, error: "internal_error", message: err instanceof Error ? err.message : String(err) },
      { status: 500 }
    );
  }
}
