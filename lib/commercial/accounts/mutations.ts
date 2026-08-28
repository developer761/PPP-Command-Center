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
  do_not_bid?: boolean;
  do_not_bid_reason?: string | null;
  billing_street?: string | null;
  billing_street2?: string | null;
  billing_city?: string | null;
  billing_state?: string | null;
  billing_zip?: string | null;
  site_street?: string | null;
  site_street2?: string | null;
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

/**
 * Three uppercase letters from a company name — "Devin's Contracting" → DEV.
 *
 * Mirrors the SQL in migrations 065/169 so a row created by the app and one
 * repaired by the backfill agree. A name with no letters at all ("123
 * Holdings") gets ACC rather than the shared "GC", so its deals are still
 * distinguishable from every other account's.
 */
export function deriveDealPrefix(companyName: string | null | undefined): string {
  const letters = (companyName ?? "").replace(/[^A-Za-z]/g, "");
  return letters ? letters.slice(0, 3).toUpperCase() : "ACC";
}

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
      // The three-letter code that opens this account's deal numbers
      // ("DEV-0001"). Migration 065 added the column and backfilled the
      // accounts that existed that day, but nothing ever set it on INSERT — so
      // every account created since carried NULL and its deals fell back to the
      // shared literal "GC". Brendan 2026-08-26: "all the opps are the same".
      deal_code_prefix: deriveDealPrefix(input.company_name),
      dba: input.dba?.trim() || null,
      industry: input.industry?.trim() || null,
      rating: input.rating ?? null,
      do_not_bid: input.do_not_bid ?? false,
      do_not_bid_reason: input.do_not_bid_reason?.trim() || null,
      billing_street: input.billing_street?.trim() || null,
      billing_street2: input.billing_street2?.trim() || null,
      billing_city: input.billing_city?.trim() || null,
      billing_state: input.billing_state?.trim() || null,
      billing_zip: input.billing_zip?.trim() || null,
      site_street: input.site_street?.trim() || null,
      site_street2: input.site_street2?.trim() || null,
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

  // Stamp WHEN a do-not-bid was set, and by whom. The reason alone ages badly:
  // "90+ days late on the last three jobs" means something different if it was
  // written last month or four years ago, and without a date nobody can judge
  // whether the call is still current. Only stamped on the transition, so an
  // unrelated edit doesn't keep refreshing the date and make an old decision
  // look new.
  const stamped: Record<string, unknown> = { ...patch };
  const wasFlagged = Boolean((before as { do_not_bid?: boolean }).do_not_bid);
  if (patch.do_not_bid !== undefined && patch.do_not_bid !== wasFlagged) {
    stamped.do_not_bid_set_at = patch.do_not_bid ? new Date().toISOString() : null;
    stamped.do_not_bid_set_by_user_id = patch.do_not_bid ? (updatedByUserId ?? null) : null;
    if (!patch.do_not_bid) stamped.do_not_bid_reason = null;
  }

  const { data, error } = await sb
    .from("commercial_accounts")
    .update({ ...stamped, updated_by_user_id: updatedByUserId ?? null })
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
): Promise<{ ok: true } | { ok: false; error: string; blockingCount?: number }> {
  const sb = commercialDb();
  const { data: before } = await sb.from("commercial_accounts").select("*").eq("id", id).maybeSingle();
  if (!before) return { ok: false, error: "Account not found." };

  // Karan 2026-07-08 cascade guard: refuse to delete an account that
  // has any invoice with money on it. That money is real — the deal
  // history stays with the account; if the user really wants it gone,
  // they must void the invoices first.
  const { data: invoiceRows } = await sb
    .from("commercial_invoices")
    .select("id, paid_cents")
    .eq("account_id", id)
    .is("deleted_at", null);
  const invoices = (invoiceRows ?? []) as { id: string; paid_cents: number }[];
  const paidInvoices = invoices.filter((i) => (i.paid_cents ?? 0) > 0);
  if (paidInvoices.length > 0) {
    return {
      ok: false,
      error: `Can't delete — this account has ${paidInvoices.length} invoice${paidInvoices.length === 1 ? "" : "s"} with recorded payments. Void those first.`,
      blockingCount: paidInvoices.length,
    };
  }

  const { error } = await sb
    .from("commercial_accounts")
    .update({
      deleted_at: new Date().toISOString(),
      updated_by_user_id: deletedByUserId ?? null,
    })
    .eq("id", id);
  if (error) return { ok: false, error: error.message };

  // Cascade: an account is the top-level container — deleting it means the whole
  // relationship is gone, so its DEALS must go too. Otherwise the deals only
  // disappear from the pipeline (which filters on account.deleted_at) but linger
  // on every surface that filters just the deal's OWN deleted_at — dashboards,
  // reports, AR, and the global Invoices list — showing stale revenue for a
  // company that no longer exists. Soft-deleting each deal in turn cascades that
  // deal's unpaid invoices + Field Ops work orders, so this one loop cleans
  // deals + invoices + jobs across the whole platform. The account-level paid-
  // invoice guard above already ran, so no per-deal delete can be blocked here.
  // Dynamic import breaks the account ↔ opportunity module cycle.
  try {
    const { data: deals } = await sb
      .from("commercial_opportunities")
      .select("id")
      .eq("account_id", id)
      .is("deleted_at", null);
    const dealIds = ((deals ?? []) as { id: string }[]).map((d) => d.id);
    if (dealIds.length > 0) {
      const { softDeleteCommercialOpportunity } = await import("@/lib/commercial/opportunities/mutations");
      for (const dealId of dealIds) {
        await softDeleteCommercialOpportunity(dealId, deletedByUserId).catch(() => undefined);
      }
    }
  } catch (err) {
    console.warn("[accounts] deal cascade delete failed:", err);
  }

  // Belt-and-braces: tear down any Field Ops work order tied straight to the
  // ACCOUNT (a one-off with no deal) — the deal cascade above already handles
  // deal-connected jobs. Together they leave no orphan on Work Orders / Status /
  // Calendar (the "Karan / k" stray-WO bug). Dynamic import breaks the cycle.
  try {
    const { cascadeDeleteJobsForOwner } = await import("@/lib/commercial/field-ops/jobs");
    await cascadeDeleteJobsForOwner({ account_id: id }, deletedByUserId ?? "system");
    // …and the bells. Each deal's own delete retires its own; this catches the
    // notifications that name the ACCOUNT (a proposal deep-link carries the
    // account id too).
    const { retireNotificationsFor } = await import("@/lib/notifications/retire");
    await retireNotificationsFor(id);
  } catch (err) {
    console.warn("[accounts] field-ops cascade delete failed:", err);
  }

  await logDelete("commercial_accounts", id, before, deletedByUserId);
  return { ok: true };
}
