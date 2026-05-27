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

  // List mode — every supplier the system knows about. Mirrors the
  // logic in /api/admin/supplier-settings/route.ts so both surfaces
  // show the same supplier list. Snapshot is allowed to fail — if SF is
  // unreachable we still return a usable response (empty supplier list +
  // an explicit warning) so the editor never shows the generic browser
  // "Load failed" message.
  let snapshot: Awaited<ReturnType<typeof loadSalesforceSnapshot>> | null = null;
  let snapshotError: string | null = null;
  try {
    snapshot = await loadSalesforceSnapshot();
  } catch (err) {
    snapshotError = err instanceof Error ? err.message : String(err);
    console.warn("[supplier-templates] snapshot load failed:", err);
  }
  if (!snapshot) {
    return NextResponse.json({
      ok: true,
      suppliers: [],
      defaults: DEFAULT_SUPPLIER_TEMPLATE,
      warning: `Couldn't reach Salesforce: ${snapshotError ?? "unknown"}. Try again in a moment.`,
    });
  }
  const supplierIds = new Set<string>();
  for (const a of snapshot.accounts) {
    if (a.type && /Vendor|Supplier|Retailer/i.test(a.type)) supplierIds.add(a.id);
  }
  for (const c of snapshot.paintColors) {
    if (c.manufacturerId) supplierIds.add(c.manufacturerId);
  }
  const accountById = new Map(snapshot.accounts.map((a) => [a.id, a]));

  // Pull which suppliers currently have CUSTOMIZED templates so the UI can
  // show "Custom" vs "Default" pills without an N+1 round-trip per supplier.
  let customizedIds = new Set<string>();
  try {
    const sb = createSupabaseAdminClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.SUPABASE_SECRET_KEY!,
      { auth: { persistSession: false, autoRefreshToken: false } }
    );
    const { data: rows } = await sb
      .from("supplier_email_templates")
      .select("supplier_account_id, subject, greeting, intro, outro, signoff");
    if (rows) {
      for (const r of rows) {
        const hasAny = [r.subject, r.greeting, r.intro, r.outro, r.signoff].some(
          (v) => typeof v === "string" && v.trim().length > 0
        );
        if (hasAny) customizedIds.add(r.supplier_account_id);
      }
    }
  } catch (err) {
    console.warn("[supplier-templates] customized lookup failed (non-fatal):", err);
    customizedIds = new Set();
  }

  // Count colors per supplier for sort priority
  const colorCountBySupplier = new Map<string, number>();
  for (const c of snapshot.paintColors) {
    if (!c.manufacturerId) continue;
    colorCountBySupplier.set(c.manufacturerId, (colorCountBySupplier.get(c.manufacturerId) ?? 0) + 1);
  }

  const suppliers = Array.from(supplierIds)
    .map((id) => {
      const acct = accountById.get(id);
      if (!acct) return null;
      return {
        supplierAccountId: id,
        supplierName: acct.name,
        sfType: acct.type,
        isBMRetailer: acct.isBMRetailer,
        colorsInCatalog: colorCountBySupplier.get(id) ?? 0,
        isCustomized: customizedIds.has(id),
      };
    })
    .filter((x): x is NonNullable<typeof x> => x !== null)
    .sort((a, b) => b.colorsInCatalog - a.colorsInCatalog || a.supplierName.localeCompare(b.supplierName));

  return NextResponse.json({
    ok: true,
    suppliers,
    defaults: DEFAULT_SUPPLIER_TEMPLATE,
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
