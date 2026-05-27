import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { getProfileByUserId } from "@/lib/auth/profile";
import { isAdminEmail } from "@/lib/auth/admin";
import { loadSalesforceSnapshot } from "@/lib/salesforce/queries";
import { createClient as createSupabaseAdminClient } from "@supabase/supabase-js";

/**
 * Supplier settings admin endpoint.
 *
 *   GET   /api/admin/supplier-settings        — Returns:
 *           - existing supplier_settings rows
 *           - candidate suppliers from the SF Account snapshot (Vendor types)
 *           - merged view per supplier with the config gaps highlighted
 *
 *   PUT   /api/admin/supplier-settings        — Upsert one supplier's config:
 *           { supplier_account_id, supplier_name, order_email, ppp_account_number,
 *             pickup_locations, is_active }
 *
 * Admin-only. No SF writes — purely Supabase + snapshot read. The supplier
 * account_id is the SF Account.Id which we already cache in the snapshot.
 */

type SupplierSettingsRow = {
  supplier_account_id: string;
  supplier_name: string;
  order_email: string | null;
  ppp_account_number: string | null;
  pickup_locations: Array<{ name: string; address: string }>;
  preferred_template_key: string | null;
  is_active: boolean;
  updated_at: string;
};

function adminClient() {
  return createSupabaseAdminClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SECRET_KEY!,
    { auth: { persistSession: false, autoRefreshToken: false } }
  );
}

export async function GET() {
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

  // 1. Existing settings rows
  const sb = adminClient();
  const { data: settingsRows, error: settingsErr } = await sb
    .from("supplier_settings")
    .select("*")
    .order("supplier_name", { ascending: true });
  if (settingsErr) {
    return NextResponse.json({ error: "settings_query_failed", message: settingsErr.message }, { status: 500 });
  }
  const settingsById = new Map<string, SupplierSettingsRow>();
  for (const row of (settingsRows ?? []) as SupplierSettingsRow[]) {
    settingsById.set(row.supplier_account_id, row);
  }

  // 2. Candidate suppliers from SF — every Account flagged as a Vendor
  //    PLUS any Account referenced by a PaintColor's Manufacturer field.
  //    The union catches retailers PPP buys from + any historical color
  //    manufacturer that isn't in the Vendor types list.
  const snapshot = await loadSalesforceSnapshot();
  const supplierIds = new Set<string>();
  for (const a of snapshot.accounts) {
    if (a.type && /Vendor|Supplier|Retailer/i.test(a.type)) {
      supplierIds.add(a.id);
    }
  }
  for (const c of snapshot.paintColors) {
    if (c.manufacturerId) supplierIds.add(c.manufacturerId);
  }
  const accountById = new Map(snapshot.accounts.map((a) => [a.id, a]));

  // 3. Merged view — for every candidate supplier, return:
  //    - sf side (name, type, isBMRetailer flag)
  //    - settings side (order_email, ppp_account_number, etc.)
  //    - gaps (missing fields, sorted to surface the highest-priority gaps first)
  type CandidateRow = {
    supplierAccountId: string;
    supplierName: string;
    sfType: string | null;
    isBMRetailer: boolean;
    settings: SupplierSettingsRow | null;
    /** Count of colors in the catalog from this supplier — proxy for
     *  how often PPP actually orders from them (high count = high priority). */
    colorsInCatalog: number;
    gaps: string[];
  };

  // Count colors per supplier for prioritization
  const colorCountBySupplier = new Map<string, number>();
  for (const c of snapshot.paintColors) {
    if (!c.manufacturerId) continue;
    colorCountBySupplier.set(c.manufacturerId, (colorCountBySupplier.get(c.manufacturerId) ?? 0) + 1);
  }

  const candidates: CandidateRow[] = [];
  for (const id of supplierIds) {
    const acct = accountById.get(id);
    if (!acct) continue; // SF account no longer in snapshot
    const settings = settingsById.get(id) ?? null;
    const gaps: string[] = [];
    if (!settings) {
      gaps.push("no_settings_row");
    } else {
      // Only flag the truly REQUIRED-to-send fields. Per the autofill/one-click
      // rule the PPP account number is optional — many suppliers don't need it
      // on every PO. When admin leaves it blank the email omits the line entirely
      // via the conditional `{{#ppp_account_number}}` block, so it's not a gap.
      // Pickup locations are also optional (only matters if worker picks pickup
      // fulfillment, and the modal handles that case independently).
      if (!settings.order_email?.trim()) gaps.push("missing_order_email");
    }
    candidates.push({
      supplierAccountId: id,
      supplierName: acct.name,
      sfType: acct.type,
      isBMRetailer: acct.isBMRetailer,
      settings,
      colorsInCatalog: colorCountBySupplier.get(id) ?? 0,
      gaps,
    });
  }

  // Sort: active+configured suppliers first (the curated 4-5), then by
  // color-catalog size desc, then by name. Active suppliers are what workers
  // actually use day-to-day — admin should see them up top, not scroll past
  // 40 unconfigured SF Vendor accounts to find BM.
  candidates.sort((a, b) => {
    const aActive = (a.settings?.is_active && a.settings?.order_email) ? 1 : 0;
    const bActive = (b.settings?.is_active && b.settings?.order_email) ? 1 : 0;
    if (aActive !== bActive) return bActive - aActive;
    return b.colorsInCatalog - a.colorsInCatalog || a.supplierName.localeCompare(b.supplierName);
  });

  return NextResponse.json({
    ok: true,
    candidates,
    summary: {
      totalCandidates: candidates.length,
      withSettings: candidates.filter((c) => c.settings !== null).length,
      readyToSend: candidates.filter((c) => c.settings?.order_email).length,
    },
  });
}

export async function PUT(request: Request) {
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
    supplier_account_id?: string;
    supplier_name?: string;
    order_email?: string | null;
    ppp_account_number?: string | null;
    pickup_locations?: Array<{ name: string; address: string }> | null;
    is_active?: boolean;
  };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "bad_json" }, { status: 400 });
  }

  if (!body.supplier_account_id || !body.supplier_name) {
    return NextResponse.json({ error: "missing_required_fields" }, { status: 400 });
  }

  // Validate email shape if provided
  if (body.order_email && !/^[a-z0-9._+\-]+@[a-z0-9.\-]+\.[a-z]{2,}$/i.test(body.order_email.trim())) {
    return NextResponse.json({ error: "invalid_email" }, { status: 400 });
  }

  // Validate pickup_locations shape if provided
  if (body.pickup_locations) {
    for (const loc of body.pickup_locations) {
      if (typeof loc !== "object" || !loc.name?.trim()) {
        return NextResponse.json({ error: "invalid_pickup_location" }, { status: 400 });
      }
    }
  }

  const sb = adminClient();
  const row: Record<string, unknown> = {
    supplier_account_id: body.supplier_account_id,
    supplier_name: body.supplier_name,
    updated_by_user_id: data.user.id,
  };
  // Only set fields the caller explicitly included so admins can update one
  // field without clobbering others.
  if ("order_email" in body) {
    row.order_email = body.order_email?.trim() || null;
  }
  if ("ppp_account_number" in body) {
    row.ppp_account_number = body.ppp_account_number?.trim() || null;
  }
  if ("pickup_locations" in body) {
    row.pickup_locations = body.pickup_locations ?? [];
  }
  if ("is_active" in body) {
    row.is_active = body.is_active;
  }

  const { error } = await sb
    .from("supplier_settings")
    .upsert(row, { onConflict: "supplier_account_id" });
  if (error) {
    return NextResponse.json({ error: "upsert_failed", message: error.message }, { status: 500 });
  }

  return NextResponse.json({ ok: true });
}
