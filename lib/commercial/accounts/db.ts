import "server-only";

import { commercialDb } from "@/lib/commercial/db";

/**
 * Read helpers for the New Platform Accounts feature (Phase 1).
 *
 * Strict separation: this file MUST NOT import from Command Center's
 * lib/salesforce/* or lib/data-source. Postgres is the source of truth here.
 */

export type CommercialAccountRating = "A" | "B" | "C";
export type CommercialComplianceStatus = "green" | "yellow" | "red" | "not_started";
export type CommercialPrequalStatus = "not_started" | "pending" | "approved" | "rejected";

export type CommercialAccount = {
  id: string;
  company_name: string;
  dba: string | null;
  industry: string | null;
  rating: CommercialAccountRating | null;
  billing_street: string | null;
  billing_city: string | null;
  billing_state: string | null;
  billing_zip: string | null;
  site_street: string | null;
  site_city: string | null;
  site_state: string | null;
  site_zip: string | null;
  phone: string | null;
  ap_phone: string | null;
  website: string | null;
  vendor_compliance_status: CommercialComplianceStatus | null;
  prequalification_status: CommercialPrequalStatus | null;
  insurance_min_liability: number | null;
  insurance_min_workers_comp: number | null;
  tax_exempt: boolean;
  tax_exempt_cert_number: string | null;
  notes: string | null;
  // Migration 034 — Alex's Key Relationship / strategic-partnership flag.
  // Surfaces as a ★ badge on every list/card so high-value accounts pop.
  // Optional in type so code keeps working on a pre-034 row.
  is_key_relationship?: boolean | null;
  created_at: string;
  updated_at: string;
  created_by_user_id: string | null;
  updated_by_user_id: string | null;
  deleted_at: string | null;
};

export type AccountsListFilters = {
  search?: string;
  rating?: CommercialAccountRating;
  compliance?: CommercialComplianceStatus;
  industry?: string;
};

/**
 * Load all non-deleted commercial accounts, sorted by company name.
 *
 * Returns empty array on any error so callers can render the empty state
 * cleanly rather than crash. Errors log via console.warn.
 */
export async function listCommercialAccounts(
  filters: AccountsListFilters = {}
): Promise<CommercialAccount[]> {
  const sb = commercialDb();
  let q = sb
    .from("commercial_accounts")
    .select("*")
    .is("deleted_at", null);

  if (filters.search) {
    // ilike covers case-insensitive substring; matches company_name OR dba.
    const term = `%${filters.search.replace(/[%_]/g, (m) => `\\${m}`)}%`;
    q = q.or(`company_name.ilike.${term},dba.ilike.${term}`);
  }
  if (filters.rating) q = q.eq("rating", filters.rating);
  if (filters.compliance) q = q.eq("vendor_compliance_status", filters.compliance);
  if (filters.industry) q = q.eq("industry", filters.industry);

  const { data, error } = await q.order("company_name", { ascending: true });
  if (error) {
    console.warn("[commercial/accounts] list failed:", error.message);
    return [];
  }
  return (data ?? []) as CommercialAccount[];
}

/** Load a single account by id. Returns null if not found or deleted. */
export async function getCommercialAccount(id: string): Promise<CommercialAccount | null> {
  const sb = commercialDb();
  const { data, error } = await sb
    .from("commercial_accounts")
    .select("*")
    .eq("id", id)
    .is("deleted_at", null)
    .maybeSingle();
  if (error) {
    console.warn("[commercial/accounts] get failed:", error.message);
    return null;
  }
  return (data as CommercialAccount | null) ?? null;
}

/** Karan 2026-07-08: load an account including soft-deleted rows so
 *  reconcile-orphan flows (deleted-account invoice cluster on the
 *  invoicing surface) can render the account name + drive bulk-delete.
 *  Callers should check `.deleted_at` on the returned row. */
export async function getCommercialAccountIncludingDeleted(id: string): Promise<CommercialAccount | null> {
  const sb = commercialDb();
  const { data, error } = await sb
    .from("commercial_accounts")
    .select("*")
    .eq("id", id)
    .maybeSingle();
  if (error) {
    console.warn("[commercial/accounts] get(inc-deleted) failed:", error.message);
    return null;
  }
  return (data as CommercialAccount | null) ?? null;
}

/**
 * Distinct industry values across non-deleted accounts. Used to populate
 * the industry filter dropdown without a separate constants list.
 */
export async function listCommercialAccountIndustries(): Promise<string[]> {
  const sb = commercialDb();
  const { data, error } = await sb
    .from("commercial_accounts")
    .select("industry")
    .is("deleted_at", null)
    .not("industry", "is", null);
  if (error) {
    console.warn("[commercial/accounts] industries failed:", error.message);
    return [];
  }
  const set = new Set<string>();
  for (const row of data ?? []) {
    const v = (row as { industry: string | null }).industry;
    if (v) set.add(v);
  }
  return Array.from(set).sort();
}
