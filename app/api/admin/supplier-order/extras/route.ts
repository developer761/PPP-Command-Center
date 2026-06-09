import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { getProfileByUserId } from "@/lib/auth/profile";
import { isAdminEmail } from "@/lib/auth/admin";
import { createClient as createSupabaseAdminClient } from "@supabase/supabase-js";

/**
 * Returns the active supplier_extras catalog for the 20-item dropdown in
 * the Supplier Order Draft Modal.
 *
 *   GET /api/admin/supplier-order/extras?supplierAccountId=<id>
 *
 * When supplierAccountId is provided, filters to items whose
 * preferred_supplier_id is null (universal) OR matches. When omitted,
 * returns ALL universal extras.
 *
 * Admin-only.
 */
export async function GET(request: Request) {
  try {
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

  const url = new URL(request.url);
  const rawSupplierId = url.searchParams.get("supplierAccountId");
  // Validate before it goes into the PostgREST `.or()` filter STRING below — a
  // value with a comma/paren/dot could break out of the expression and alter
  // the query. SF Account ids + the synthetic "__general__" are [A-Za-z0-9_]
  // only; anything else is treated as "no supplier" (universal items only).
  const supplierAccountId =
    rawSupplierId && /^[A-Za-z0-9_]+$/.test(rawSupplierId) ? rawSupplierId : null;

  const sb = createSupabaseAdminClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SECRET_KEY!,
    { auth: { persistSession: false, autoRefreshToken: false } }
  );

  let query = sb
    .from("supplier_extras")
    .select("id, name, unit, default_qty, preferred_supplier_id, sort_order")
    .eq("is_active", true)
    .order("sort_order", { ascending: true });

  // Filter: universal items (preferred_supplier_id IS NULL) OR matching the
  // current supplier. PostgREST handles the OR via `or` filter syntax.
  if (supplierAccountId) {
    query = query.or(`preferred_supplier_id.is.null,preferred_supplier_id.eq.${supplierAccountId}`);
  } else {
    query = query.is("preferred_supplier_id", null);
  }

  const { data: rows, error } = await query;
  if (error) {
    console.error("[supplier-order/extras] query failed:", error);
    return NextResponse.json({ ok: false, error: error.message, extras: [] }, { status: 500 });
  }

  return NextResponse.json(
    { ok: true, extras: rows ?? [] },
    {
      headers: {
        // Extras catalog is admin-curated (~20 rows) and changes rarely.
        // Modal mounts hit this every time the worker opens an order draft;
        // 5-min private cache keeps repeat opens instant. SWR continues
        // serving cached data while a background refresh happens, so the
        // worker never waits on a network round-trip for the catalog.
        "Cache-Control": "private, max-age=300, stale-while-revalidate=300",
      },
    }
  );
  } catch (err) {
    console.error("[supplier-order/extras GET] unhandled:", err);
    return NextResponse.json(
      { ok: false, error: "internal_error", message: err instanceof Error ? err.message : String(err) },
      { status: 500 }
    );
  }
}
