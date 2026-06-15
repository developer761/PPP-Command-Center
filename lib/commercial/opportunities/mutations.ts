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

  const status: OpportunityStatus = input.status ?? "inquiry";
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
 *  deletion — this is only for "I created this by mistake." */
export async function softDeleteCommercialOpportunity(
  id: string,
  deletedByUserId?: string | null
): Promise<{ ok: true } | { ok: false; error: string }> {
  const sb = commercialDb();
  const { data: before } = await sb
    .from("commercial_opportunities")
    .select("*")
    .eq("id", id)
    .is("deleted_at", null)
    .maybeSingle();
  if (!before) return { ok: false, error: "Opportunity not found." };

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
  await logDelete("commercial_opportunities", id, before, deletedByUserId);
  void after; // logDelete captures the row
  return { ok: true };
}
