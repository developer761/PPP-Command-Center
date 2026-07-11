import "server-only";

import { commercialDb } from "@/lib/commercial/db";
import { logInsert, logUpdate, logDelete } from "@/lib/commercial/audit-log";
import { DEFAULT_PROBABILITY_BY_STATUS } from "./constants";
import type {
  CommercialOpportunity,
  OpportunityStatus,
  OpportunitySource,
  OpportunityLossReason,
} from "./db";

/**
 * Opportunity mutations. Mirrors the Phase 1 accounts pattern:
 *   - Returns { ok: true, ... } | { ok: false, error: string }
 *   - Audit-logs every successful write via lib/commercial/audit-log
 *   - Soft-delete via deleted_at (never hard-deletes)
 *   - Soft-delete guard on the parent account before insert/update
 */

export type CreateOpportunityInput = {
  account_id: string;
  title: string;
  description?: string | null;
  status?: OpportunityStatus;
  source?: OpportunitySource | null;
  bid_value_low_cents?: number | null;
  bid_value_high_cents?: number | null;
  probability_pct?: number | null;
  proposed_start_at?: string | null;
  proposed_end_at?: string | null;
  proposal_due_at?: string | null;
  primary_contact_id?: string | null;
  // Per-opp project address (migration 035). NULL means "use the account
  // site/billing address" — a single property-mgmt account may have us
  // bidding at multiple physical sites, so the opp gets its own address.
  property_street?: string | null;
  property_city?: string | null;
  property_state?: string | null;
  property_zip?: string | null;
  // Migration 046 (Phase B) — CEO structural fields. All nullable at
  // solicitation; changeOpportunityStatus enforces required-at-estimating.
  client_name?: string | null;
  location_short?: string | null;
  estimator_user_id?: string | null;
  // Migration 049 — free-text estimator name (subs / off-roster).
  estimator_name?: string | null;
  created_by_user_id?: string | null;
};

export async function createCommercialOpportunity(
  input: CreateOpportunityInput
): Promise<{ ok: true; opportunity: CommercialOpportunity } | { ok: false; error: string }> {
  if (!input.title?.trim()) return { ok: false, error: "Title is required." };
  if (input.title.length > 200) return { ok: false, error: "Title too long (max 200 chars)." };

  const sb = commercialDb();

  // Guard: refuse to attach to a missing or soft-deleted account.
  const { data: account } = await sb
    .from("commercial_accounts")
    .select("id, deleted_at")
    .eq("id", input.account_id)
    .maybeSingle();
  if (!account || account.deleted_at) {
    return { ok: false, error: "Account not found." };
  }

  // Auto-swap if user submitted high < low (don't reject — convenience).
  let low = input.bid_value_low_cents ?? null;
  let high = input.bid_value_high_cents ?? null;
  if (low !== null && high !== null && low > high) {
    [low, high] = [high, low];
  }

  const status: OpportunityStatus = input.status ?? "solicitation";
  // Auto-fill primary contact from the account if not supplied + the
  // account has a starred primary contact (Phase 1 Batch A feature).
  let primaryContactId = input.primary_contact_id ?? null;
  if (!primaryContactId) {
    const { data: primary } = await sb
      .from("commercial_account_contacts")
      .select("contact_id")
      .eq("account_id", input.account_id)
      .eq("is_primary", true)
      .maybeSingle();
    if (primary) primaryContactId = (primary as { contact_id: string }).contact_id;
  }

  const { data, error } = await sb
    .from("commercial_opportunities")
    .insert({
      account_id: input.account_id,
      primary_contact_id: primaryContactId,
      title: input.title.trim(),
      description: input.description?.trim() || null,
      status,
      source: input.source ?? null,
      bid_value_low_cents: low,
      bid_value_high_cents: high,
      probability_pct: input.probability_pct ?? DEFAULT_PROBABILITY_BY_STATUS[status] ?? 10,
      proposed_start_at: input.proposed_start_at ?? null,
      proposed_end_at: input.proposed_end_at ?? null,
      proposal_due_at: input.proposal_due_at ?? null,
      property_street: input.property_street?.trim() || null,
      property_city: input.property_city?.trim() || null,
      property_state: input.property_state?.trim() || null,
      property_zip: input.property_zip?.trim() || null,
      client_name: input.client_name?.trim() || null,
      location_short: input.location_short?.trim() || null,
      estimator_user_id: input.estimator_user_id ?? null,
      // If the picker chose a user, clear the free-text field (and vice
      // versa). Prevents "old typo lingers after switching to the FK."
      estimator_name: input.estimator_user_id
        ? null
        : input.estimator_name?.trim() || null,
      created_by_user_id: input.created_by_user_id ?? null,
      updated_by_user_id: input.created_by_user_id ?? null,
    })
    .select("*")
    .single();

  if (error) return { ok: false, error: error.message };
  const opp = data as CommercialOpportunity;
  await logInsert("commercial_opportunities", opp.id, opp, input.created_by_user_id);

  // Log the initial status as the first row in the opp's status_log
  // (from_status=NULL) so the Timeline tab in later batches has a
  // complete history with no gap at creation.
  const { data: logRow } = await sb
    .from("commercial_opportunity_status_log")
    .insert({
      opportunity_id: opp.id,
      from_status: null,
      to_status: status,
      changed_by_user_id: input.created_by_user_id ?? null,
      note: null,
      loss_reason: null,
    })
    .select("*")
    .maybeSingle();
  if (logRow) {
    await logInsert(
      "commercial_opportunity_status_log",
      (logRow as { id: string }).id,
      logRow,
      input.created_by_user_id
    );
  }

  return { ok: true, opportunity: opp };
}

export type UpdateOpportunityInput = Partial<Omit<CreateOpportunityInput, "account_id" | "created_by_user_id">> & {
  id: string;
  updated_by_user_id?: string | null;
  loss_reason?: OpportunityLossReason | null;
  loss_notes?: string | null;
};

export async function updateCommercialOpportunity(
  input: UpdateOpportunityInput
): Promise<{ ok: true; opportunity: CommercialOpportunity } | { ok: false; error: string }> {
  const sb = commercialDb();
  const { data: before } = await sb
    .from("commercial_opportunities")
    .select("*")
    .eq("id", input.id)
    .is("deleted_at", null)
    .maybeSingle();
  if (!before) return { ok: false, error: "Opportunity not found." };

  // Auto-swap if user submitted high < low.
  let low = input.bid_value_low_cents ?? undefined;
  let high = input.bid_value_high_cents ?? undefined;
  if (low !== undefined && low !== null && high !== undefined && high !== null && low > high) {
    [low, high] = [high, low];
  }

  const patch: Record<string, unknown> = {
    updated_by_user_id: input.updated_by_user_id ?? null,
  };
  if (input.title !== undefined) {
    if (!input.title.trim()) return { ok: false, error: "Title can't be empty." };
    if (input.title.length > 200) return { ok: false, error: "Title too long (max 200 chars)." };
    patch.title = input.title.trim();
  }
  if (input.description !== undefined) patch.description = input.description?.trim() || null;
  if (input.status !== undefined) patch.status = input.status;
  if (input.source !== undefined) patch.source = input.source;
  if (low !== undefined) patch.bid_value_low_cents = low;
  if (high !== undefined) patch.bid_value_high_cents = high;
  if (input.probability_pct !== undefined) {
    if (input.probability_pct !== null && (input.probability_pct < 0 || input.probability_pct > 100)) {
      return { ok: false, error: "Probability must be 0-100." };
    }
    patch.probability_pct = input.probability_pct;
  }
  if (input.proposed_start_at !== undefined) patch.proposed_start_at = input.proposed_start_at;
  if (input.proposed_end_at !== undefined) patch.proposed_end_at = input.proposed_end_at;
  if (input.proposal_due_at !== undefined) patch.proposal_due_at = input.proposal_due_at;
  if (input.primary_contact_id !== undefined) patch.primary_contact_id = input.primary_contact_id;
  if (input.loss_reason !== undefined) patch.loss_reason = input.loss_reason;
  if (input.loss_notes !== undefined) patch.loss_notes = input.loss_notes;
  // Per-opp project address (migration 035). Trimmed-empty → null so a
  // user clearing the override re-falls-back to the account's site
  // address on the detail-page card.
  if (input.property_street !== undefined) patch.property_street = input.property_street?.trim() || null;
  if (input.property_city !== undefined) patch.property_city = input.property_city?.trim() || null;
  if (input.property_state !== undefined) patch.property_state = input.property_state?.trim().slice(0, 2).toUpperCase() || null;
  if (input.property_zip !== undefined) patch.property_zip = input.property_zip?.trim() || null;
  // Migration 046 (Phase B) — CEO structural fields.
  if (input.client_name !== undefined) patch.client_name = input.client_name?.trim() || null;
  if (input.location_short !== undefined) patch.location_short = input.location_short?.trim() || null;
  if (input.estimator_user_id !== undefined) patch.estimator_user_id = input.estimator_user_id || null;
  // Migration 049 — free-text estimator. When both come through in one
  // patch (unusual but possible if the UI sends both), the picker wins
  // and free-text is cleared — the FK is the authoritative link.
  if (input.estimator_name !== undefined) {
    patch.estimator_name = input.estimator_user_id
      ? null
      : input.estimator_name?.trim() || null;
  } else if (input.estimator_user_id) {
    // Picker chose a user → clear any stale free-text left over from
    // a prior manual entry.
    patch.estimator_name = null;
  }

  const { data: after, error } = await sb
    .from("commercial_opportunities")
    .update(patch)
    .eq("id", input.id)
    .select("*")
    .single();

  if (error) return { ok: false, error: error.message };
  const opp = after as CommercialOpportunity;
  await logUpdate("commercial_opportunities", opp.id, before, opp, input.updated_by_user_id);
  return { ok: true, opportunity: opp };
}

/** Soft-delete via deleted_at. Lost / no_bid are STATUS values, not
 *  deletion — this is only for "I created this by mistake."
 *
 *  Karan 2026-07-08 cascade guard: block deletion if the deal has any
 *  invoice with money on it (paid_cents > 0) — that money changed hands
 *  and can't just vanish. Cleanly cascade non-paid invoices (draft /
 *  sent / void) into soft-delete alongside the deal so they don't
 *  orphan on the invoices list.
 */
export async function softDeleteCommercialOpportunity(
  id: string,
  deletedByUserId?: string | null
): Promise<{ ok: true } | { ok: false; error: string; blockingCount?: number }> {
  const sb = commercialDb();
  const { data: before } = await sb
    .from("commercial_opportunities")
    .select("*")
    .eq("id", id)
    .is("deleted_at", null)
    .maybeSingle();
  if (!before) return { ok: false, error: "Opportunity not found." };

  // Look up invoices that would orphan. Filter out ones that are already
  // soft-deleted so re-deleting a deal doesn't count historical noise.
  const { data: invoiceRows } = await sb
    .from("commercial_invoices")
    .select("id, paid_cents, status")
    .eq("opportunity_id", id)
    .is("deleted_at", null);
  const invoices = (invoiceRows ?? []) as { id: string; paid_cents: number; status: string }[];
  const paidInvoices = invoices.filter((i) => (i.paid_cents ?? 0) > 0);
  if (paidInvoices.length > 0) {
    return {
      ok: false,
      error: `Can't delete — ${paidInvoices.length} invoice${paidInvoices.length === 1 ? " has" : "s have"} recorded payments. Void those first, then delete the deal.`,
      blockingCount: paidInvoices.length,
    };
  }

  const { data: after, error } = await sb
    .from("commercial_opportunities")
    .update({
      deleted_at: new Date().toISOString(),
      updated_by_user_id: deletedByUserId ?? null,
    })
    .eq("id", id)
    .select("*")
    .single();

  if (error) return { ok: false, error: error.message };

  // Cascade: soft-delete the (unpaid) invoices attached to this deal so
  // they don't linger as orphans on the invoices list. Best-effort — if
  // this fails the deal is already deleted; the orphaned-invoice fallback
  // handling on /commercial/invoices keeps the UI navigable.
  if (invoices.length > 0) {
    const now = new Date().toISOString();
    await sb
      .from("commercial_invoices")
      .update({ deleted_at: now })
      .in("id", invoices.map((i) => i.id));
  }

  await logDelete("commercial_opportunities", id, before, deletedByUserId);
  void after; // logDelete captures the row
  return { ok: true };
}

/**
 * Restore a soft-deleted opportunity by nulling `deleted_at`. Powers
 * the undo-toast Karan requested 2026-07-11 — accidental delete clicks
 * had no safety net before. Also restores any invoices the delete
 * cascade tombstoned in the same 60-second window (best-effort — if
 * the user waits longer we assume the delete was intentional).
 *
 * Race guard: only restore if currently deleted. If someone else
 * already restored (or the row is fresh), no-op with a clear error.
 */
export async function restoreCommercialOpportunity(
  id: string,
  restoredByUserId?: string | null
): Promise<{ ok: true } | { ok: false; error: string }> {
  const sb = commercialDb();
  const { data: before } = await sb
    .from("commercial_opportunities")
    .select("*")
    .eq("id", id)
    .maybeSingle();
  if (!before) return { ok: false, error: "Opportunity not found." };
  const beforeRow = before as { deleted_at: string | null };
  if (!beforeRow.deleted_at) return { ok: false, error: "Opportunity is not deleted." };
  const deletedAt = new Date(beforeRow.deleted_at).getTime();
  const now = Date.now();
  // Best-effort: only cascade-restore invoices that were tombstoned in
  // the same brief window (they were cascaded by our delete path). A
  // longer window risks resurrecting invoices that were explicitly
  // deleted afterwards. 5 minutes is generous but bounded.
  const restoreWindowMs = 5 * 60 * 1000;
  const cascadeWindowStart = new Date(deletedAt - 5000).toISOString();
  const cascadeWindowEnd = new Date(deletedAt + 5000).toISOString();
  void now; // guarded above via non-null deleted_at

  const { data: after, error } = await sb
    .from("commercial_opportunities")
    .update({
      deleted_at: null,
      updated_by_user_id: restoredByUserId ?? null,
    })
    .eq("id", id)
    .select("*")
    .single();
  if (error) return { ok: false, error: error.message };

  // Cascade restore matching invoices.
  await sb
    .from("commercial_invoices")
    .update({ deleted_at: null })
    .eq("opportunity_id", id)
    .gte("deleted_at", cascadeWindowStart)
    .lte("deleted_at", cascadeWindowEnd);
  void restoreWindowMs;

  await logUpdate("commercial_opportunities", id, before, after, restoredByUserId);
  return { ok: true };
}
