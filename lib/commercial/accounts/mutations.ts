import "server-only";

import { commercialDb } from "@/lib/commercial/db";
import { logInsert, logUpdate, logDelete } from "@/lib/commercial/audit-log";
import type { CommercialAccount } from "./db";

/**
 * Write helpers for commercial_accounts. Every mutation calls the audit
 * helpers from lib/commercial/audit-log.ts so the change is logged to
 * commercial_audit_log per the platform's "Full audit trail" requirement.
 */

export type CreateAccountInput = {
  company_name: string;
  dba?: string | null;
  industry?: string | null;
  rating?: "A" | "B" | "C" | null;
  billing_street?: string | null;
  billing_city?: string | null;
  billing_state?: string | null;
  billing_zip?: string | null;
  site_street?: string | null;
  site_city?: string | null;
  site_state?: string | null;
  site_zip?: string | null;
  phone?: string | null;
  ap_phone?: string | null;
  website?: string | null;
  vendor_compliance_status?: "green" | "yellow" | "red" | "not_started" | null;
  prequalification_status?: "not_started" | "pending" | "approved" | "rejected" | null;
  insurance_min_liability?: number | null;
  insurance_min_workers_comp?: number | null;
  tax_exempt?: boolean;
  tax_exempt_cert_number?: string | null;
  notes?: string | null;
  // Migration 034 — Alex's Key Relationship flag. Optional on create
  // (defaults FALSE in the column), set via Edit on existing accounts.
  is_key_relationship?: boolean;
  created_by_user_id?: string | null;
};

export async function createCommercialAccount(
  input: CreateAccountInput
): Promise<{ ok: true; account: CommercialAccount } | { ok: false; error: string }> {
  if (!input.company_name?.trim()) {
    return { ok: false, error: "Company name is required." };
  }
  const sb = commercialDb();
  const { data, error } = await sb
    .from("commercial_accounts")
    .insert({
      company_name: input.company_name.trim(),
      dba: input.dba?.trim() || null,
      industry: input.industry?.trim() || null,
      rating: input.rating ?? null,
      billing_street: input.billing_street?.trim() || null,
      billing_city: input.billing_city?.trim() || null,
      billing_state: input.billing_state?.trim() || null,
      billing_zip: input.billing_zip?.trim() || null,
      site_street: input.site_street?.trim() || null,
      site_city: input.site_city?.trim() || null,
      site_state: input.site_state?.trim() || null,
      site_zip: input.site_zip?.trim() || null,
      phone: input.phone?.trim() || null,
      ap_phone: input.ap_phone?.trim() || null,
      website: input.website?.trim() || null,
      vendor_compliance_status: input.vendor_compliance_status ?? "not_started",
      prequalification_status: input.prequalification_status ?? "not_started",
      insurance_min_liability: input.insurance_min_liability ?? null,
      insurance_min_workers_comp: input.insurance_min_workers_comp ?? null,
      tax_exempt: input.tax_exempt ?? false,
      tax_exempt_cert_number: input.tax_exempt_cert_number?.trim() || null,
      notes: input.notes?.trim() || null,
      is_key_relationship: input.is_key_relationship ?? false,
      created_by_user_id: input.created_by_user_id ?? null,
      updated_by_user_id: input.created_by_user_id ?? null,
    })
    .select("*")
    .single();

  if (error) {
    console.warn("[commercial/accounts] create failed:", error.message);
    return { ok: false, error: error.message };
  }

  const account = data as CommercialAccount;
  await logInsert("commercial_accounts", account.id, account, input.created_by_user_id);
  return { ok: true, account };
}

export async function updateCommercialAccount(
  id: string,
  patch: Partial<CreateAccountInput>,
  updatedByUserId?: string | null
): Promise<{ ok: true; account: CommercialAccount } | { ok: false; error: string }> {
  const sb = commercialDb();
  // Read existing for the audit log before/after.
  const { data: before } = await sb.from("commercial_accounts").select("*").eq("id", id).maybeSingle();
  if (!before) return { ok: false, error: "Account not found." };

  const { data, error } = await sb
    .from("commercial_accounts")
    .update({ ...patch, updated_by_user_id: updatedByUserId ?? null })
    .eq("id", id)
    .select("*")
    .single();
  if (error) return { ok: false, error: error.message };

  const account = data as CommercialAccount;
  await logUpdate("commercial_accounts", id, before, account, updatedByUserId);
  return { ok: true, account };
}

export async function softDeleteCommercialAccount(
  id: string,
  deletedByUserId?: string | null
): Promise<{ ok: true } | { ok: false; error: string }> {
  const sb = commercialDb();
  const { data: before } = await sb.from("commercial_accounts").select("*").eq("id", id).maybeSingle();
  if (!before) return { ok: false, error: "Account not found." };

  const { error } = await sb
    .from("commercial_accounts")
    .update({
      deleted_at: new Date().toISOString(),
      updated_by_user_id: deletedByUserId ?? null,
    })
    .eq("id", id);
  if (error) return { ok: false, error: error.message };

  await logDelete("commercial_accounts", id, before, deletedByUserId);
  return { ok: true };
}
