import "server-only";

import { createClient } from "@supabase/supabase-js";

/**
 * Per-supplier email template system. Mirrors lib/customer-form/templates.ts
 * (single-row-per-supplier table + code defaults). NULL columns fall back
 * to the code defaults below so the system always produces a valid email
 * even when supplier_email_templates row is missing.
 *
 * Variables substituted via the render() function — see migration 008 for
 * the canonical list. Unknown variables are left as literal {{key}} so
 * misnamed placeholders are visible at QA time rather than silently empty.
 */

export type SupplierEmailTemplate = {
  subject: string;
  greeting: string;
  intro: string;
  outro: string;
  signoff: string;
};

/** Code-shipped defaults. These render a valid order email for ANY supplier
 *  even before admin has customized per-supplier copy. */
export const DEFAULT_SUPPLIER_TEMPLATE: SupplierEmailTemplate = {
  subject:
    "PPP Order {{po_number}} — {{customer_name}} (WO {{wo_number}})",
  greeting: "Hi {{supplier_name}} team,",
  intro:
    "Please prepare the following order for {{ppp_brand}}.\n\n" +
    "PPP Account: {{ppp_account_number}}\n" +
    "PO Number: {{po_number}}\n" +
    "Required by: {{required_by_date}}\n" +
    "Fulfillment: {{fulfillment_block}}\n\n" +
    "CUSTOMER + JOB\n" +
    "Customer: {{customer_name}}\n" +
    "Work Order: #{{wo_number}}\n",
  outro:
    "Reply to this email to confirm + provide delivery date / tracking info.\n" +
    "All replies route to our Command Center inbox.",
  signoff: "Thanks,\n{{ppp_brand}}",
};

type DBRow = Partial<SupplierEmailTemplate> & {
  supplier_account_id?: string;
  updated_at?: string;
};

function adminClient() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SECRET_KEY!,
    { auth: { persistSession: false, autoRefreshToken: false } }
  );
}

/**
 * Load the template for a specific supplier. Never throws — missing table,
 * missing row, or RLS issue all fall through to DEFAULT_SUPPLIER_TEMPLATE.
 */
export async function loadSupplierTemplate(
  supplierAccountId: string
): Promise<{ template: SupplierEmailTemplate; isCustomized: boolean }> {
  try {
    const sb = adminClient();
    const { data, error } = await sb
      .from("supplier_email_templates")
      .select("*")
      .eq("supplier_account_id", supplierAccountId)
      .maybeSingle();
    if (error || !data) {
      return { template: DEFAULT_SUPPLIER_TEMPLATE, isCustomized: false };
    }
    const row = data as DBRow;
    const merged: SupplierEmailTemplate = { ...DEFAULT_SUPPLIER_TEMPLATE };
    let any = false;
    for (const k of Object.keys(DEFAULT_SUPPLIER_TEMPLATE) as Array<keyof SupplierEmailTemplate>) {
      const v = row[k];
      if (typeof v === "string" && v.trim().length > 0) {
        merged[k] = v;
        any = true;
      }
    }
    return { template: merged, isCustomized: any };
  } catch (err) {
    console.warn(
      `[supplier-order/templates] loadSupplierTemplate(${supplierAccountId}) failed; using defaults:`,
      err
    );
    return { template: DEFAULT_SUPPLIER_TEMPLATE, isCustomized: false };
  }
}

/** Upsert overrides for a specific supplier. Null = clear that field. */
export async function saveSupplierTemplate(
  supplierAccountId: string,
  supplierName: string,
  patch: Partial<Record<keyof SupplierEmailTemplate, string | null>>,
  updatedByUserId?: string
): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    const sb = adminClient();
    const row: Record<string, unknown> = {
      supplier_account_id: supplierAccountId,
    };
    for (const [k, v] of Object.entries(patch)) {
      if (v === null || typeof v === "string") row[k] = v;
    }
    if (updatedByUserId) row.updated_by_user_id = updatedByUserId;
    // Upsert by primary key so first edit creates the row.
    const { error } = await sb
      .from("supplier_email_templates")
      .upsert(row, { onConflict: "supplier_account_id" });
    if (error) return { ok: false, error: error.message };
    // Mirror supplier_name into supplier_settings so the settings page
    // always has a readable label. Best-effort — non-fatal on conflict.
    await sb
      .from("supplier_settings")
      .upsert(
        { supplier_account_id: supplierAccountId, supplier_name: supplierName },
        { onConflict: "supplier_account_id", ignoreDuplicates: true }
      );
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/** Same Mustache-lite substitution used in customer-form templates. */
export function render(template: string, vars: Record<string, string | null | undefined>): string {
  return template.replace(/\{\{\s*([a-z_][a-z0-9_]*)\s*\}\}/gi, (full, key) => {
    const v = vars[key];
    if (v === undefined) return full; // keep literal {{key}} for QA visibility
    return v === null ? "" : v;
  });
}
