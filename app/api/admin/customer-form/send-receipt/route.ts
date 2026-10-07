import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createClient as createSupabaseAdminClient } from "@supabase/supabase-js";
import { getProfileByUserId } from "@/lib/auth/profile";
import { isAdminEmail } from "@/lib/auth/admin";
import { capabilitiesFor, roleForProfile } from "@/lib/auth/roles";
import { loadFormRenderData } from "@/lib/customer-form/render-data";
import { roomLabelFrom } from "@/lib/customer-form/room-label";
import { buildReceiptRooms, receiptIsEmpty, receiptRecipient } from "@/lib/customer-form/receipt-lines";
import { sendCustomerFormConfirmation } from "@/lib/email/resend";

/**
 * Send the customer their receipt — on purpose, by a person, after review.
 *
 * Katie, 2026-10-01, on whether Internal Entry should auto-send one: "not
 * automatically sent but have a button available to send if clicked? That
 * allows our team to update/save and come back and make adjustments before
 * sending to the customer — they can review to make sure it's ready."
 *
 * So a customer filling the form in themselves still gets their receipt
 * automatically (they already know what they picked), and an AM entering
 * colors on somebody's behalf gets a button instead — because that entry is
 * half-finished for most of its life and a receipt for a half-finished entry
 * is worse than none.
 *
 * THE RECIPIENT IS NOT `token.customer_email` ON AN INTERNAL TOKEN. That
 * column holds whoever opened the entry screen, which is a PPP staff member;
 * mailing them a receipt addressed to the customer is the bug this route
 * exists to avoid. The real address is resolved from the work order through
 * the same schema-driven discovery the "Send Color Form" modal uses.
 */
export const dynamic = "force-dynamic";

function adminDb() {
  return createSupabaseAdminClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SECRET_KEY!,
    { auth: { persistSession: false, autoRefreshToken: false } }
  );
}

export async function POST(request: Request) {
  const supabase = await createClient();
  const { data } = await supabase.auth.getUser();
  if (!data?.user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const profile = await getProfileByUserId(data.user.id);
  const role = roleForProfile(profile, isAdminEmail(data.user.email));
  // Account managers do Internal Entry, so the gate is "can enter colors",
  // not "is an admin" — an AM who just typed the colors is exactly the person
  // Katie wants clicking this.
  if (!capabilitiesFor(role).canEnterColors) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  let body: { token?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "bad_json" }, { status: 400 });
  }
  const token = String(body.token ?? "").trim();
  if (!token) return NextResponse.json({ error: "missing_token" }, { status: 400 });

  const db = adminDb();
  const { data: row, error } = await db
    .from("customer_form_tokens")
    .select("token, kind, work_order_id, customer_email, customer_name, submitted_payload, submitted_at, color_deadline")
    .eq("token", token)
    .maybeSingle();
  if (error || !row) return NextResponse.json({ error: "no_such_token" }, { status: 404 });

  // Nothing saved yet — there is no receipt to send, and an empty one would
  // tell the customer we have their colors when we do not.
  const payload = (row.submitted_payload ?? null) as { lineItems?: unknown; globalNotes?: unknown } | null;
  if (!row.submitted_at || !payload) {
    return NextResponse.json({
      error: "nothing_saved",
      message: "Save the colors first — there's nothing to send a receipt for yet.",
    }, { status: 400 });
  }

  // Room names come from the live work order, not the stored payload: the
  // customer's email should name the rooms the way the form named them.
  const fresh = await loadFormRenderData(row.work_order_id).catch(() => null);
  const roomLabelById = new Map<string, string>();
  for (const li of fresh?.lineItems ?? []) {
    if (li.id) roomLabelById.set(li.id, roomLabelFrom(li.areaLabel, li.productName));
  }

  const lineItems = Array.isArray(payload.lineItems)
    ? (payload.lineItems as Array<{ id?: string | null; surfaces?: unknown; notes?: string | null }>)
    : [];
  const rooms = buildReceiptRooms({ lineItems, roomLabelById });
  const globalNotes = typeof payload.globalNotes === "string" ? payload.globalNotes : null;
  if (receiptIsEmpty(rooms, globalNotes)) {
    return NextResponse.json({
      error: "nothing_to_confirm",
      message: "There are no colors or notes saved on this form yet.",
    }, { status: 400 });
  }

  // Resolve the recipient. An internal token's own column is a staff address,
  // so for those the work order decides — see receiptRecipient.
  let workOrderEmail: string | null = null;
  let workOrderCustomerName: string | null = null;
  let source = "token";
  if (row.kind === "internal") {
    const origin = new URL(request.url).origin;
    try {
      const lookup = await fetch(
        `${origin}/api/admin/customer-form/wo-email?workOrderId=${encodeURIComponent(row.work_order_id)}`,
        { headers: { cookie: request.headers.get("cookie") ?? "" }, cache: "no-store" }
      );
      const found = await lookup.json();
      workOrderEmail = found?.email ?? null;
      workOrderCustomerName = found?.customerName ?? null;
      source = `work order (${found?.source ?? "unknown"})`;
    } catch {
      workOrderEmail = null;
    }
  }

  const { email: to, name: customerName } = receiptRecipient({
    tokenKind: row.kind,
    tokenEmail: row.customer_email,
    tokenCustomerName: row.customer_name,
    workOrderEmail,
    workOrderCustomerName,
  });

  if (!to) {
    return NextResponse.json({
      error: "no_customer_email",
      message:
        "No customer email found on this work order. Add one in Salesforce, then send the receipt.",
    }, { status: 400 });
  }

  const baseUrl = (process.env.NEXT_PUBLIC_APP_URL ?? "").replace(/\/$/, "") || new URL(request.url).origin;
  const result = await sendCustomerFormConfirmation({
    to,
    customerName,
    workOrderNumber: fresh?.workOrderNumber ?? null,
    // The customer gets a link they can actually use. An internal token is a
    // staff link, so this hands them the work order's own customer form when
    // one exists, and otherwise still links the saved selections.
    formUrl: `${baseUrl}/select/${row.token}`,
    rooms,
    globalNotes,
    colorDeadline: (row.color_deadline as string | null) ?? null,
    senderEmail: profile?.email ?? data.user.email ?? null,
  });

  if (!result.ok) {
    return NextResponse.json({ error: "send_failed", message: result.error, to }, { status: 500 });
  }
  return NextResponse.json({ ok: true, to, source, sentBy: profile?.email ?? data.user.email });
}
