import { NextResponse } from "next/server";
import { resolveViewer } from "@/lib/auth/viewer-server";
import { createClient as createSupabaseAdminClient } from "@supabase/supabase-js";

/**
 * Lightweight read-only endpoint that returns the admin-configured active
 * supplier list. Used by:
 *   - Materials page "Add supplier manually" picker (when SF colors don't
 *     have a manufacturer attached, worker still needs to pick somewhere
 *     to send the order).
 *   - Multi-supplier batch compose modal.
 *
 * Accessible to any signed-in user (workers + admin). No scope filter —
 * admin-configured suppliers are global to the org, not per-rep.
 *
 * Returns only suppliers where supplier_settings.is_active=true AND
 * order_email is set (otherwise Send would be disabled anyway).
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
  orderEmail: string;
  pppAccountNumber: string | null;
  isBMRetailer: boolean;
  /** Did admin configure pickup locations? Used by the modal to hint
   *  delivery vs pickup as the default. */
  hasPickupLocations: boolean;
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
    const { data: rows, error } = await sb
      .from("supplier_settings")
      .select("supplier_account_id, supplier_name, order_email, ppp_account_number, pickup_locations, is_bm_retailer, sort_order")
      .eq("is_active", true)
      .not("order_email", "is", null);
    if (error) {
      // is_bm_retailer / sort_order may be missing in older deployments. Retry
      // without them so the picker still renders.
      const retry = await sb
        .from("supplier_settings")
        .select("supplier_account_id, supplier_name, order_email, ppp_account_number, pickup_locations")
        .eq("is_active", true)
        .not("order_email", "is", null);
      if (retry.error) {
        return NextResponse.json({ ok: false, error: "query_failed", message: retry.error.message }, { status: 500 });
      }
      const suppliers: ActiveSupplier[] = (retry.data ?? [])
        .filter((r) => r.order_email && r.supplier_account_id)
        .map((r) => ({
          accountId: r.supplier_account_id as string,
          name: (r.supplier_name ?? r.supplier_account_id) as string,
          orderEmail: r.order_email as string,
          pppAccountNumber: (r.ppp_account_number as string | null) ?? null,
          isBMRetailer: false,
          hasPickupLocations: Array.isArray(r.pickup_locations) && r.pickup_locations.length > 0,
        }))
        .sort((a, b) => a.name.localeCompare(b.name));
      return NextResponse.json({ ok: true, suppliers });
    }

    const suppliers: ActiveSupplier[] = (rows ?? [])
      .filter((r) => r.order_email && r.supplier_account_id)
      .map((r) => {
        const pickup = Array.isArray(r.pickup_locations) ? r.pickup_locations : [];
        return {
          accountId: r.supplier_account_id as string,
          name: (r.supplier_name ?? r.supplier_account_id) as string,
          orderEmail: r.order_email as string,
          pppAccountNumber: (r.ppp_account_number as string | null) ?? null,
          isBMRetailer: Boolean(r.is_bm_retailer),
          hasPickupLocations: pickup.length > 0,
          // Carry sort_order forward for the picker's display order. NULL last,
          // then ascending. Used by the `.sort()` below.
          _sortOrder: typeof r.sort_order === "number" ? r.sort_order : null,
        } as ActiveSupplier & { _sortOrder: number | null };
      })
      .sort((a, b) => {
        const ao = (a as ActiveSupplier & { _sortOrder: number | null })._sortOrder;
        const bo = (b as ActiveSupplier & { _sortOrder: number | null })._sortOrder;
        if (ao == null && bo == null) return a.name.localeCompare(b.name);
        if (ao == null) return 1;  // unsorted go last
        if (bo == null) return -1;
        if (ao !== bo) return ao - bo;
        return a.name.localeCompare(b.name);
      })
      .map((s) => {
        // Strip the internal _sortOrder before returning
        const { _sortOrder: _drop, ...clean } = s as ActiveSupplier & { _sortOrder: number | null };
        return clean as ActiveSupplier;
      });

    return NextResponse.json({ ok: true, suppliers });
  } catch (err) {
    console.error("[suppliers/active GET] unhandled:", err);
    return NextResponse.json(
      { ok: false, error: "internal_error", message: err instanceof Error ? err.message : String(err) },
      { status: 500 }
    );
  }
}
