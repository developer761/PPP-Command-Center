import { isCompanyEmail } from "@/lib/auth/company-domain";
import Link from "next/link";
import { createClient as createSupabaseAdminClient } from "@supabase/supabase-js";
import OrderFulfillmentView from "@/components/order-fulfillment-view";
import { loadOrderPageData, loadBuildPayload } from "@/lib/materials/order-page-data";
import { createClient } from "@/lib/supabase/server";
import { getProfileByUserId } from "@/lib/auth/profile";

export const dynamic = "force-dynamic";

/** Supplier display name, from Katie's curated supplier_settings list. */
async function loadSupplierName(supplierAccountId: string): Promise<string> {
  try {
    const sb = createSupabaseAdminClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.SUPABASE_SECRET_KEY!,
      { auth: { persistSession: false, autoRefreshToken: false } }
    );
    const { data } = await sb
      .from("supplier_settings")
      .select("supplier_name")
      .eq("supplier_account_id", supplierAccountId)
      .maybeSingle();
    return (data?.supplier_name as string | null) ?? "this supplier";
  } catch {
    return "this supplier";
  }
}

/**
 * Who is placing the order — their name for the email sign-off line and their
 * stored phone as the default contact number (Kate round-3 #29).
 *
 * The phone column arrives in migration 145, so the select is tolerant: if the
 * column isn't there yet the field simply starts empty rather than 500-ing the
 * page. (Guardrail learned the hard way elsewhere in this codebase: a column
 * missing from a PostgREST select returns undefined and never errors, but a
 * select naming a missing column DOES error.)
 */
async function loadViewerContact(): Promise<{ name: string | null; phone: string | null; email: string | null }> {
  try {
    const supabase = await createClient();
    const { data } = await supabase.auth.getUser();
    if (!data?.user) return { name: null, phone: null, email: null };
    const profile = await getProfileByUserId(data.user.id);
    const name =
      (profile?.sf_user_name ?? "").trim() ||
      (data.user.email ?? "").split("@")[0] ||
      null;

    let phone: string | null = null;
    try {
      const sb = createSupabaseAdminClient(
        process.env.NEXT_PUBLIC_SUPABASE_URL!,
        process.env.SUPABASE_SECRET_KEY!,
        { auth: { persistSession: false, autoRefreshToken: false } }
      );
      const { data: row, error } = await sb
        .from("profiles")
        .select("phone")
        .eq("user_id", data.user.id)
        .maybeSingle();
      if (!error) phone = (row?.phone as string | null) ?? null;
    } catch {
      // Migration 145 pending — leave the field blank and editable.
    }

    // R4.29: only a PPP mailbox goes in front of a vendor. The send route CCs
    // on exactly this rule, so printing a personal address here would invite a
    // reply to someone who isn't even on the thread.
    const email = isCompanyEmail(data.user.email) ? (data.user.email ?? null) : null;
    return { name, phone, email };
  } catch {
    return { name: null, phone: null, email: null };
  }
}

export default async function OrderFulfillmentPage({
  params,
}: {
  params: Promise<{ woId: string; supplierId: string }>;
}) {
  const { woId, supplierId } = await params;
  const cleanWoId = decodeURIComponent(woId).trim().replace(/^['"]|['"]$/g, "");
  const supplierAccountId = decodeURIComponent(supplierId).trim();

  const data = await loadOrderPageData(cleanWoId);

  if (!data) {
    return (
      <div className="max-w-lg mx-auto py-16 text-center">
        <h1 className="text-lg font-bold text-ppp-navy">Work order not available</h1>
        <p className="mt-2 text-sm text-ppp-charcoal-500">
          This work order isn&apos;t in your open-materials list — it may be closed, or outside
          what you can see.
        </p>
        <Link
          href="/dashboard/materials"
          className="mt-6 inline-flex items-center px-4 py-2 min-h-[44px] rounded-lg bg-ppp-blue text-ppp-navy text-sm font-semibold hover:bg-ppp-blue-300 transition-colors"
        >
          Back to materials
        </Link>
      </div>
    );
  }

  if (!data.canOrderMaterials) {
    return (
      <div className="max-w-lg mx-auto py-16 text-center">
        <h1 className="text-lg font-bold text-ppp-navy">Account Managers can&rsquo;t order materials</h1>
        <p className="mt-2 text-sm text-ppp-charcoal-500">
          You can enter colors and send the color form. Placing the material order is handled by an admin, regional manager or rep.
        </p>
        <Link
          href={`/dashboard/materials/${encodeURIComponent(data.workOrderId)}`}
          className="mt-6 inline-flex items-center px-4 py-2 min-h-[44px] rounded-lg bg-ppp-blue text-ppp-navy text-sm font-semibold hover:bg-ppp-blue-300 transition-colors"
        >
          Back to work order
        </Link>
      </div>
    );
  }

  const [build, supplierName, contact] = await Promise.all([
    loadBuildPayload(data.workOrderId, supplierAccountId),
    loadSupplierName(supplierAccountId),
    loadViewerContact(),
  ]);

  return (
    <OrderFulfillmentView
      workOrderId={data.workOrderId}
      workOrderNumber={data.job.wo.workOrderNumber ?? null}
      customerName={data.job.wo.accountName ?? null}
      supplierAccountId={supplierAccountId}
      supplierName={supplierName}
      build={build.payload}
      committed={build.committed}
      persistenceAvailable={build.available}
      savedFulfillment={build.fulfillment}
      viewerName={contact.name}
      viewerPhone={contact.phone}
      viewerEmail={contact.email}
    />
  );
}
