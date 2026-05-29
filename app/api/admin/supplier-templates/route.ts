import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { getProfileByUserId } from "@/lib/auth/profile";
import { isAdminEmail } from "@/lib/auth/admin";
import {
  loadSupplierTemplate,
  saveSupplierTemplate,
  DEFAULT_SUPPLIER_TEMPLATE,
  type SupplierEmailTemplate,
} from "@/lib/supplier-order/templates";
import { loadSalesforceSnapshot } from "@/lib/salesforce/queries";
import { createClient as createSupabaseAdminClient } from "@supabase/supabase-js";

/**
 * Per-supplier email templates — admin can customize the subject /
 * greeting / intro / outro / signoff per supplier (BM gets a friendlier
 * greeting than Romeo's, etc.). NULL fields fall back to
 * DEFAULT_SUPPLIER_TEMPLATE in lib/supplier-order/templates.ts.
 *
 *   GET  /api/admin/supplier-templates           — list every supplier
 *                                                  (snapshot ∪ settings)
 *                                                  + their merged template
 *   GET  /api/admin/supplier-templates?supplierAccountId=<id>
 *                                                — one supplier's template
 *                                                  + the defaults for diff
 *   PUT  /api/admin/supplier-templates
 *        body: { supplierAccountId, supplierName, patch: {...} }
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
  const supplierAccountId = url.searchParams.get("supplierAccountId");

  // Single-supplier mode — used by the editor when admin clicks a supplier
  if (supplierAccountId) {
    const { template, isCustomized } = await loadSupplierTemplate(supplierAccountId);
    return NextResponse.json({
      ok: true,
      supplierAccountId,
      template,
      defaults: DEFAULT_SUPPLIER_TEMPLATE,
      isCustomized,
    });
  }

  // List mode — the supplier universe IS PPP's curated vendor list
  // (supplier_settings), the stores PPP actually orders from. NOT the ~2,000 SF
  // Vendor accounts. Load the settings rows + customized-template ids; the SF
  // snapshot is OPTIONAL enrichment (BM-retailer flag / canonical name) and is
  // allowed to fail — the curated list still renders without it.
  type SettingRow = { supplier_account_id: string; supplier_name: string; is_active: boolean; order_email: string | null };
  let settingsRows: SettingRow[] = [];
  const customizedIds = new Set<string>();
  try {
    const sb = createSupabaseAdminClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.SUPABASE_SECRET_KEY!,
      { auth: { persistSession: false, autoRefreshToken: false } }
    );
    const [templatesRes, settingsRes] = await Promise.allSettled([
      sb.from("supplier_email_templates")
        .select("supplier_account_id, subject, greeting, intro, outro, signoff"),
      sb.from("supplier_settings")
        .select("supplier_account_id, supplier_name, is_active, order_email"),
    ]);
    if (templatesRes.status === "fulfilled" && templatesRes.value.data) {
      for (const r of templatesRes.value.data) {
        const hasAny = [r.subject, r.greeting, r.intro, r.outro, r.signoff].some(
          (v) => typeof v === "string" && v.trim().length > 0
        );
        if (hasAny) customizedIds.add(r.supplier_account_id);
      }
    }
    if (settingsRes.status === "fulfilled" && settingsRes.value.data) {
      settingsRows = (settingsRes.value.data as SettingRow[]);
    } else if (settingsRes.status === "rejected") {
      console.warn("[supplier-templates] settings load failed:", settingsRes.reason);
    }
  } catch (err) {
    console.warn("[supplier-templates] lookup failed (non-fatal):", err);
  }

  // Optional SF enrichment for canonical name / BM-retailer flag.
  const accountById = new Map<string, { name: string; type: string | null; isBMRetailer: boolean }>();
  try {
    const snapshot = await loadSalesforceSnapshot();
    for (const a of snapshot.accounts) {
      accountById.set(a.id, { name: a.name, type: a.type, isBMRetailer: a.isBMRetailer });
    }
  } catch (err) {
    console.warn("[supplier-templates] snapshot enrichment skipped:", err);
  }

  // ?filter=all shows inactive vendors too; default "active".
  const filter = url.searchParams.get("filter") === "all" ? "all" : "active";
  const rows = filter === "active" ? settingsRows.filter((r) => r.is_active) : settingsRows;

  const suppliers = rows
    .map((r) => {
      const acct = accountById.get(r.supplier_account_id);
      return {
        supplierAccountId: r.supplier_account_id,
        supplierName: acct?.name ?? r.supplier_name,
        sfType: acct?.type ?? null,
        isBMRetailer: acct?.isBMRetailer ?? false,
        colorsInCatalog: 0,
        isCustomized: customizedIds.has(r.supplier_account_id),
        isActive: r.is_active,
      };
    })
    .sort((a, b) => a.supplierName.localeCompare(b.supplierName));

  return NextResponse.json({
    ok: true,
    suppliers,
    defaults: DEFAULT_SUPPLIER_TEMPLATE,
    filter,
    totalCandidates: settingsRows.length,
    activeCount: settingsRows.filter((r) => r.is_active).length,
    showingFallback: false,
  });
  } catch (err) {
    console.error("[supplier-templates GET] unhandled:", err);
    return NextResponse.json(
      {
        ok: false,
        error: "internal_error",
        message: err instanceof Error ? err.message : String(err),
      },
      { status: 500 }
    );
  }
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
    supplierAccountId?: string;
    supplierName?: string;
    patch?: Partial<Record<keyof SupplierEmailTemplate, string | null>>;
  };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "bad_json" }, { status: 400 });
  }

  if (!body.supplierAccountId || !body.supplierName) {
    return NextResponse.json({ error: "missing_required_fields" }, { status: 400 });
  }
  if (!body.patch || typeof body.patch !== "object") {
    return NextResponse.json({ error: "missing_patch" }, { status: 400 });
  }

  // Whitelist the keys we accept
  const allowedKeys = new Set(Object.keys(DEFAULT_SUPPLIER_TEMPLATE) as Array<keyof SupplierEmailTemplate>);
  const sanitized: Partial<Record<keyof SupplierEmailTemplate, string | null>> = {};
  for (const [k, v] of Object.entries(body.patch)) {
    if (!allowedKeys.has(k as keyof SupplierEmailTemplate)) continue;
    // Empty string === null (clear to default) — same convention as the
    // customer-templates editor.
    if (v === null || (typeof v === "string" && v.trim().length === 0)) {
      sanitized[k as keyof SupplierEmailTemplate] = null;
    } else if (typeof v === "string") {
      sanitized[k as keyof SupplierEmailTemplate] = v;
    }
  }

  if (Object.keys(sanitized).length === 0) {
    return NextResponse.json({ error: "nothing_to_update" }, { status: 400 });
  }

  const result = await saveSupplierTemplate(
    body.supplierAccountId,
    body.supplierName,
    sanitized,
    data.user.id
  );
  if (!result.ok) {
    return NextResponse.json({ error: "save_failed", message: result.error }, { status: 500 });
  }

  // Return the fresh merged template
  const { template } = await loadSupplierTemplate(body.supplierAccountId);
  return NextResponse.json({ ok: true, template });
}
