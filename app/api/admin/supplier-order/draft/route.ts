import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { getProfileByUserId } from "@/lib/auth/profile";
import { isAdminEmail } from "@/lib/auth/admin";
import { loadSalesforceSnapshot } from "@/lib/salesforce/queries";
import { buildSupplierOrderDraft, type FulfillmentMethod, type SupplierOrderExtra } from "@/lib/supplier-order/builder";
import { createClient as createSupabaseAdminClient } from "@supabase/supabase-js";

/**
 * Generates an auto-populated supplier order draft for a given WO + supplier.
 * Used by the Supplier Order Draft Modal to populate the preview before the
 * admin reviews + sends.
 *
 *   POST /api/admin/supplier-order/draft
 *   body: {
 *     workOrderId: string,
 *     supplierAccountId: string,           — Account.Id of the supplier
 *     fulfillmentMethod?: 'delivery'|'pickup',  default 'delivery'
 *     pickupLocation?: string,             — when method='pickup'
 *     extras?: Array<{ extraId, name, unit, qty }>,
 *     specialInstructions?: string,
 *     requiredByDate?: string,             — ISO date override
 *   }
 *
 * Returns the full draft (subject + body + line items + delivery address +
 * sent_to_email + ppp_account_number + flags for missing-data states).
 *
 * No DB writes — this is a pure "generate the preview" endpoint. The actual
 * send + draft persistence happens in /api/admin/supplier-order/send.
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
    supplierAccountId?: string;
    fulfillmentMethod?: FulfillmentMethod;
    pickupLocation?: string;
    extras?: SupplierOrderExtra[];
    specialInstructions?: string;
    requiredByDate?: string;
  };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "bad_json" }, { status: 400 });
  }

  if (!body.workOrderId) {
    return NextResponse.json({ error: "missing_work_order_id" }, { status: 400 });
  }
  if (!body.supplierAccountId) {
    return NextResponse.json({ error: "missing_supplier_account_id" }, { status: 400 });
  }

  const snapshot = await loadSalesforceSnapshot();
  const workOrder = snapshot.workOrders.find((w) => w.id === body.workOrderId);
  if (!workOrder) {
    return NextResponse.json({ error: "wo_not_in_snapshot" }, { status: 404 });
  }
  const supplierAccount = snapshot.accounts.find((a) => a.id === body.supplierAccountId);
  if (!supplierAccount) {
    return NextResponse.json({ error: "supplier_not_in_snapshot" }, { status: 404 });
  }
  // Find customer account by name (WO doesn't carry accountId today — derive
  // via name lookup matching the rest of the dashboard).
  const customerAccount = workOrder.accountName
    ? snapshot.accounts.find((a) => a.name === workOrder.accountName) ?? null
    : null;

  // WOLI rows for this WO
  const woliRows = snapshot.woLineItems.filter((w) => w.workOrderId === workOrder.id);

  // Paint color lookup
  const paintColorsById = new Map(snapshot.paintColors.map((c) => [c.id, c]));

  // Pull the customer's most-recent SUBMITTED form payload from Supabase. The
  // builder uses this for both color picks AND any customer-corrected delivery
  // address. When no submission exists yet (admin trying to order before
  // customer picked colors), builder.noColorsPicked=true and the UI will warn.
  let customerSubmittedPayload = null;
  try {
    const sbAdmin = createSupabaseAdminClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.SUPABASE_SECRET_KEY!,
      { auth: { persistSession: false, autoRefreshToken: false } }
    );
    const { data: tokenRow } = await sbAdmin
      .from("customer_form_tokens")
      .select("submitted_payload")
      .eq("work_order_id", workOrder.id)
      .not("submitted_at", "is", null)
      .order("submitted_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (tokenRow?.submitted_payload) {
      customerSubmittedPayload = tokenRow.submitted_payload as unknown as ReturnType<typeof Object>;
    }
  } catch (err) {
    console.warn("[supplier-order/draft] customer payload load failed (non-fatal):", err);
  }

  const draft = await buildSupplierOrderDraft({
    workOrder,
    woliRows,
    paintColorsById,
    customerAccount,
    supplierAccountId: body.supplierAccountId,
    supplierAccount,
    customerSubmittedPayload: customerSubmittedPayload as never,
    fulfillmentMethod: body.fulfillmentMethod ?? "delivery",
    pickupLocation: body.pickupLocation,
    extras: body.extras ?? [],
    specialInstructions: body.specialInstructions,
    requiredByDate: body.requiredByDate,
  });

  return NextResponse.json({ ok: true, draft });
}
