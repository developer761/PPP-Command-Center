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
 *  even before admin has customized per-supplier copy.
 *
 *  Conditional blocks use the Mustache-style `{{#var}}…{{/var}}` syntax —
 *  the block renders only when the variable resolves to a non-empty string, so
 *  an optional field is OMITTED rather than rendered as a blank label. Nobody
 *  should ever be shown a placeholder.
 *
 *  `ppp_account_number` is still substituted and can be added back per-supplier
 *  in Settings, but it is no longer in the default body: Karan 2026-09-08, the
 *  PO number is the work order number and that is the only reference a vendor
 *  needs from us. */
export const DEFAULT_SUPPLIER_TEMPLATE: SupplierEmailTemplate = {
  // The customer clause is CONDITIONAL: a work order with no Account resolved
  // used to mail the supplier "PPP Order PPP-WO00316046 — (unknown customer)
  // (WO 00316046)". The PO already identifies the order, so when there is no
  // customer the clause disappears instead of advertising a gap in our data.
  //
  // The trailing "(WO …)" is gone with it — Katie item 16: the PO IS the work
  // order number now, so printing both said the same thing twice.
  subject:
    "PPP Order {{po_number}}{{#customer_name}} — {{customer_name}}{{/customer_name}}",
  // R4.23: the vendor's own name came out of the greeting. They know who they
  // are; it read as mail-merge filler, and when supplier_settings held a
  // slightly different name than the account it was visibly wrong.
  greeting: "Hi there,",
  // Katie items 16 + 18, 2026-09-08:
  //   · "PO should = WO Number. Once the WO number is listed under PO, we can
  //     remove the standalone WO line." The PO and the work order were the same
  //     job printed twice; the Work Order line is gone.
  //   · The PPP Account line was kept at first on Katie's "Customer Number is
  //     our PPP account number", then dropped by Karan on the same day: the PO
  //     already identifies the order and a second reference is noise.
  //   · "Deliver on … by 8AM", replacing "Required by".
  intro:
    "Please prepare the following order for {{ppp_brand}}.\n\n" +
    // Karan 2026-09-08: the PPP Account line is OUT. The PO is the work order
    // number and that is the only reference a vendor needs from us — the
    // account number was a second identifier for the same order.
    //
    // `ppp_account_number` stays available as a template variable, so a
    // supplier who does need it can have it added back per-template in
    // Settings without a code change.
    "PO Number: {{po_number}}\n" +
    "Deliver on: {{required_by_date}}, by {{delivery_time}}\n" +
    "Fulfillment: {{fulfillment_block}}\n" +
    "{{#customer_name}}\nThis order is for {{customer_name}}.\n{{/customer_name}}",
  // R4.28: "All replies route to our Command Center inbox." removed — it's an
  // internal detail the vendor has no use for, and it read like a warning.
  outro: "Reply to this email to confirm + provide delivery date / tracking info.\n",
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

/** Mustache-lite substitution with conditional section support.
 *
 *  Variables: `{{key}}` substitutes vars[key]. Unknown keys stay literal
 *  for QA visibility. Null/empty resolves to empty string.
 *
 *  Conditional sections: `{{#key}}…{{/key}}` renders the block ONLY when
 *  vars[key] is a non-empty string. Used to omit lines like "PPP Account:"
 *  when the field isn't configured, instead of rendering a blank label.
 *  Variables inside the block are substituted as normal.
 *
 *  Sections are processed FIRST so the block's content is removed before
 *  the unknown-variable check fires inside it. The regex is non-greedy
 *  (`[\s\S]*?`) so two adjacent blocks don't collapse into one.
 */
export function render(template: string, vars: Record<string, string | null | undefined>): string {
  const withSectionsResolved = template.replace(
    /\{\{#\s*([a-z_][a-z0-9_]*)\s*\}\}([\s\S]*?)\{\{\/\s*\1\s*\}\}/gi,
    (_full, key, inner) => {
      const v = vars[key];
      if (typeof v === "string" && v.trim().length > 0) return inner;
      return "";
    }
  );
  return withSectionsResolved.replace(/\{\{\s*([a-z_][a-z0-9_]*)\s*\}\}/gi, (full, key) => {
    const v = vars[key];
    if (v === undefined) return full; // keep literal {{key}} for QA visibility
    return v === null ? "" : v;
  });
}
