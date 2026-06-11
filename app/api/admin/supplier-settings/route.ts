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
  phone_only?: boolean;
  phone_number?: string | null;
  pickup_default?: boolean;
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

  // 2. The supplier universe IS PPP's curated vendor list (supplier_settings) —
  //    the stores PPP actually orders from (Katie's list), NOT the ~2,000 SF
  //    Vendor accounts. Many of those vendors are stores, not SF Accounts, so
  //    they only live in supplier_settings. Enrich with SF account data when the
  //    id happens to be a real SF Account (for the BM-retailer flag / canonical
  //    name); otherwise use the settings row as-is.
  type CandidateRow = {
    supplierAccountId: string;
    supplierName: string;
    sfType: string | null;
    isBMRetailer: boolean;
    settings: SupplierSettingsRow | null;
    colorsInCatalog: number;
    gaps: string[];
  };

  const accountById = new Map<string, { name: string; type: string | null; isBMRetailer: boolean }>();
  const colorCountBySupplier = new Map<string, number>();
  try {
    const snapshot = await loadSalesforceSnapshot();
    for (const a of snapshot.accounts) {
      accountById.set(a.id, { name: a.name, type: a.type, isBMRetailer: a.isBMRetailer });
    }
    for (const c of snapshot.paintColors) {
      if (c.manufacturerId) colorCountBySupplier.set(c.manufacturerId, (colorCountBySupplier.get(c.manufacturerId) ?? 0) + 1);
    }
  } catch {
    // Snapshot is only for enrichment — the curated list still renders without it.
  }

  const candidates: CandidateRow[] = [];
  for (const row of (settingsRows ?? []) as SupplierSettingsRow[]) {
    const acct = accountById.get(row.supplier_account_id);
    const gaps: string[] = [];
    if (!row.order_email?.trim()) gaps.push("missing_order_email");
    candidates.push({
      supplierAccountId: row.supplier_account_id,
      supplierName: acct?.name ?? row.supplier_name,
      sfType: acct?.type ?? null,
      isBMRetailer: acct?.isBMRetailer ?? false,
      settings: row,
      colorsInCatalog: colorCountBySupplier.get(row.supplier_account_id) ?? 0,
      gaps,
    });
  }

  // Active+ready suppliers first, then by name.
  candidates.sort((a, b) => {
    const aActive = (a.settings?.is_active && a.settings?.order_email) ? 1 : 0;
    const bActive = (b.settings?.is_active && b.settings?.order_email) ? 1 : 0;
    if (aActive !== bActive) return bActive - aActive;
    return a.supplierName.localeCompare(b.supplierName);
  });

  return NextResponse.json({
    ok: true,
    candidates,
    summary: {
      totalCandidates: candidates.length,
      withSettings: candidates.length,
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
    phone_only?: boolean;
    phone_number?: string | null;
    pickup_default?: boolean;
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
  if ("phone_only" in body) {
    row.phone_only = body.phone_only;
  }
  if ("phone_number" in body) {
    row.phone_number = body.phone_number?.trim() || null;
  }
  if ("pickup_default" in body) {
    row.pickup_default = body.pickup_default;
  }

  const { error } = await sb
    .from("supplier_settings")
    .upsert(row, { onConflict: "supplier_account_id" });
  if (error) {
    return NextResponse.json({ error: "upsert_failed", message: error.message }, { status: 500 });
  }

  return NextResponse.json({ ok: true });
}

/**
 * POST /api/admin/supplier-settings — Create a brand-new supplier that doesn't
 *   exist in PPP's Salesforce yet. Body: { supplier_name, order_email,
 *   ppp_account_number?, pickup_locations? }. Generates a synthetic
 *   supplier_account_id `custom_<slug>_<rand>` so the row coexists with
 *   SF-Account-keyed rows without colliding. Returns the new id.
 *
 *   Use case: Katie 2026-06-10 — workers need to add a supplier inline
 *   from the picker without round-tripping to SF + waiting for the next
 *   snapshot. Active rows show up on the picker via /api/suppliers/active
 *   within the cache window (≤10 min).
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
    supplier_name?: string;
    order_email?: string | null;
    ppp_account_number?: string | null;
    pickup_locations?: Array<{ name: string; address: string }> | null;
  };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "bad_json" }, { status: 400 });
  }

  const name = body.supplier_name?.trim();
  if (!name) {
    return NextResponse.json({ error: "missing_supplier_name" }, { status: 400 });
  }
  if (name.length > 200) {
    return NextResponse.json({ error: "supplier_name_too_long" }, { status: 400 });
  }
  const email = body.order_email?.trim() ?? null;
  if (email && !/^[a-z0-9._+\-]+@[a-z0-9.\-]+\.[a-z]{2,}$/i.test(email)) {
    return NextResponse.json({ error: "invalid_email" }, { status: 400 });
  }
  if (body.pickup_locations) {
    for (const loc of body.pickup_locations) {
      if (typeof loc !== "object" || !loc.name?.trim()) {
        return NextResponse.json({ error: "invalid_pickup_location" }, { status: 400 });
      }
    }
  }

  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 40) || "supplier";
  // 6-char random suffix keeps it unique against name collisions; full-uuid
  // would work but the readable id helps DB grepping during incidents.
  const suffix = Math.random().toString(36).slice(2, 8);
  const id = `custom_${slug}_${suffix}`;

  const sb = adminClient();
  // Duplicate-name guard. Without this, admin can typo-create the same
  // supplier twice and the picker shows two rows for one real vendor.
  // Case-insensitive compare so "BM Ronkonkoma" vs "bm ronkonkoma" collides.
  const { data: existingByName, error: dupCheckErr } = await sb
    .from("supplier_settings")
    .select("supplier_account_id, supplier_name")
    .ilike("supplier_name", name);
  if (dupCheckErr) {
    return NextResponse.json({ error: "dup_check_failed", message: dupCheckErr.message }, { status: 500 });
  }
  if (existingByName && existingByName.length > 0) {
    return NextResponse.json({
      error: "duplicate_name",
      message: `A supplier named "${existingByName[0].supplier_name}" already exists. Open Settings → Suppliers and edit that row instead.`,
    }, { status: 409 });
  }
  const { error } = await sb
    .from("supplier_settings")
    .insert({
      supplier_account_id: id,
      supplier_name: name,
      order_email: email,
      ppp_account_number: body.ppp_account_number?.trim() || null,
      pickup_locations: body.pickup_locations ?? [],
      is_active: true,
      updated_by_user_id: data.user.id,
    });
  if (error) {
    return NextResponse.json({ error: "insert_failed", message: error.message }, { status: 500 });
  }
  return NextResponse.json({ ok: true, supplier_account_id: id });
}
