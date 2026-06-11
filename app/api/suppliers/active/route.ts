import { NextResponse } from "next/server";
import { resolveViewer } from "@/lib/auth/viewer-server";
import { createClient as createSupabaseAdminClient } from "@supabase/supabase-js";

/**
 * Lightweight read-only endpoint that returns the admin-configured
 * supplier list. Used by:
 *   - Materials page "Add supplier manually" picker (when SF colors don't
 *     have a manufacturer attached, worker still needs to pick somewhere
 *     to send the order).
 *   - Multi-supplier batch compose modal.
 *
 * Accessible to any signed-in user (workers + admin). No scope filter —
 * admin-configured suppliers are global to the org, not per-rep.
 *
 * Per Katie 2026-06-10: returns EVERY supplier_settings row that's not
 * been explicitly soft-deleted (only filter is `order_email IS NOT NULL`
 * for email suppliers OR `phone_only = true` for phone suppliers — both
 * are usable on a paint order). The picker shows them all; workers can
 * pick any of the 8 suppliers PPP has on file, not just the "active 5".
 */

function adminClient() {
  return createSupabaseAdminClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SECRET_KEY!,
    { auth: { persistSession: false, autoRefreshToken: false } }
  );
}

export type ActiveSupplier = {
  accountId: string;
  name: string;
  /** Email is empty string when the supplier is phone-only. UI must check
   *  `phoneOnly` before treating this as a real address. */
  orderEmail: string;
  pppAccountNumber: string | null;
  isBMRetailer: boolean;
  /** Did admin configure pickup locations? Used by the modal to hint
   *  delivery vs pickup as the default. */
  hasPickupLocations: boolean;
  /** When true, the supplier-order modal hides email Send / Copy buttons
   *  and shows a "Call this supplier" panel with `phoneNumber`. */
  phoneOnly: boolean;
  phoneNumber: string | null;
  /** When true, the supplier-order modal opens with fulfillment_method
   *  = pickup pre-selected. Per-supplier override of the address-based
   *  NYC default; admin can still toggle to delivery per order. */
  pickupDefault: boolean;
  /** is_active=false means the supplier is in soft-retirement. UI shows
   *  a muted "Inactive" badge but still allows ordering. */
  isActive: boolean;
};

export async function GET() {
  try {
    const viewer = await resolveViewer({});
    if (!viewer) {
      return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    }

    // PERF: this endpoint used to call loadSalesforceSnapshot() just to read
    // is_bm_retailer + a canonical name per supplier — but the snapshot can
    // take 10s+ on cold cache, which made the Pick a Supplier modal hang for
    // up to a minute (Katie 2026-06-03). The supplier list is admin-curated
    // in supplier_settings already; we don't need the snapshot for it.
    // is_bm_retailer + sort_order are now read directly from the table.
    const sb = adminClient();
    // Read every supplier_settings row. Filter the result set in JS so we
    // can gracefully degrade if the newer columns aren't present yet.
    const richSelect = "supplier_account_id, supplier_name, order_email, ppp_account_number, pickup_locations, is_active, is_bm_retailer, sort_order, phone_only, phone_number, pickup_default";
    const { data: rows, error } = await sb
      .from("supplier_settings")
      .select(richSelect);
    // Supabase types the rows narrowly based on the SELECT; we accept either
    // shape and re-key into our internal Row type. Cast to a loose array so
    // the retry path (which has fewer columns) doesn't fail the type check.
    let safeRows: Array<Record<string, unknown>> | null = rows as unknown as Array<Record<string, unknown>> | null;
    if (error) {
      // Older deployments missing the phone_only / pickup_default / sort_order
      // columns — retry with the base set. UI degrades to "email-only, no
      // phone affordance" until migration 016 is applied.
      const retry = await sb
        .from("supplier_settings")
        .select("supplier_account_id, supplier_name, order_email, ppp_account_number, pickup_locations, is_active");
      if (retry.error) {
        return NextResponse.json({ ok: false, error: "query_failed", message: retry.error.message }, { status: 500 });
      }
      safeRows = (retry.data as unknown as Array<Record<string, unknown>> | null);
    }

    type Row = {
      supplier_account_id?: string;
      supplier_name?: string;
      order_email?: string | null;
      ppp_account_number?: string | null;
      pickup_locations?: unknown;
      is_active?: boolean;
      is_bm_retailer?: boolean;
      sort_order?: number | null;
      phone_only?: boolean;
      phone_number?: string | null;
      pickup_default?: boolean;
    };
    const suppliers: ActiveSupplier[] = (safeRows ?? [])
      // A supplier is "usable" if it has EITHER an email OR is phone-only
      // with a phone number. Filters out half-configured rows that would
      // crash the order modal.
      .filter((r: Row) => {
        if (!r.supplier_account_id) return false;
        const hasEmail = typeof r.order_email === "string" && r.order_email.length > 0;
        const hasPhone = Boolean(r.phone_only) && typeof r.phone_number === "string" && r.phone_number.length > 0;
        return hasEmail || hasPhone;
      })
      .map((r: Row) => {
        const pickup = Array.isArray(r.pickup_locations) ? r.pickup_locations as Array<{name:string;address:string}> : [];
        return {
          accountId: r.supplier_account_id as string,
          name: (r.supplier_name ?? r.supplier_account_id) as string,
          orderEmail: (r.order_email ?? "") as string,
          pppAccountNumber: (r.ppp_account_number as string | null) ?? null,
          isBMRetailer: Boolean(r.is_bm_retailer),
          hasPickupLocations: pickup.length > 0,
          phoneOnly: Boolean(r.phone_only),
          phoneNumber: (r.phone_number as string | null) ?? null,
          pickupDefault: Boolean(r.pickup_default),
          isActive: r.is_active !== false, // default true if missing
          _sortOrder: typeof r.sort_order === "number" ? r.sort_order : null,
        } as ActiveSupplier & { _sortOrder: number | null };
      })
      .sort((a, b) => {
        // Active first, then by admin-set sort_order, then alpha
        if (a.isActive !== b.isActive) return a.isActive ? -1 : 1;
        const ao = (a as ActiveSupplier & { _sortOrder: number | null })._sortOrder;
        const bo = (b as ActiveSupplier & { _sortOrder: number | null })._sortOrder;
        if (ao == null && bo == null) return a.name.localeCompare(b.name);
        if (ao == null) return 1;
        if (bo == null) return -1;
        if (ao !== bo) return ao - bo;
        return a.name.localeCompare(b.name);
      })
      .map((s) => {
        const { _sortOrder: _drop, ...clean } = s as ActiveSupplier & { _sortOrder: number | null };
        return clean as ActiveSupplier;
      });

    return NextResponse.json({ ok: true, suppliers }, {
      // Per Katie 2026-06-10: admin can now add a new supplier inline from
      // the picker. Cut the cache to 30 seconds (down from 5 min) so newly-
      // added suppliers appear quickly. The endpoint is cheap (single
      // Supabase query) so the freshness > cache trade-off is worth it.
      // stale-while-revalidate keeps perceived latency low after the
      // 30-second window: workers see the cached list immediately while the
      // browser refreshes silently.
      headers: { "Cache-Control": "private, max-age=30, stale-while-revalidate=60" },
    });
  } catch (err) {
    console.error("[suppliers/active GET] unhandled:", err);
    return NextResponse.json(
      { ok: false, error: "internal_error", message: err instanceof Error ? err.message : String(err) },
      { status: 500 }
    );
  }
}
