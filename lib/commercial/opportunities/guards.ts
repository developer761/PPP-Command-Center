import "server-only";

import { commercialDb } from "@/lib/commercial/db";

/**
 * Shared chain-of-trust guard. Verifies the parent opp exists + isn't
 * soft-deleted, AND the parent account isn't soft-deleted. Returns the
 * opp's id + account_id on success (handy for downstream queries).
 *
 * This is the canonical pattern that should wrap EVERY mutation entry
 * point on commercial_opportunities-scoped libs (notes, tasks, finishes,
 * submittals, submittal-items, attachments). Extracting it solves three
 * problems flagged in the 2026-06-30 post-build audit:
 *   - C5/H2: same 14-line block was copy-pasted into 6+ functions
 *   - Soft-delete chain-of-trust gap: editOpportunitySubmittal,
 *     changeSubmittalStatus, deleteOpportunitySubmittal, finishes
 *     edit/delete, attachment link/unlink, submittal-items mutations
 *     all paired (opp_id, child_id) but skipped the parent-deleted check
 *   - Type-safety: 18 inline `as { ... }` casts replaced by a single
 *     typed return shape
 *
 * Returns ok=false on missing opp / soft-deleted opp / soft-deleted
 * account. The error message is user-facing — no Postgres internals.
 */

export type OppEditableContext = {
  opportunity_id: string;
  account_id: string;
};

export async function verifyOppEditable(
  opportunity_id: string
): Promise<{ ok: true; ctx: OppEditableContext } | { ok: false; error: string }> {
  const sb = commercialDb();

  const { data: opp } = await sb
    .from("commercial_opportunities")
    .select("id, account_id, deleted_at")
    .eq("id", opportunity_id)
    .maybeSingle();
  if (!opp) return { ok: false, error: "Opportunity not found." };
  const oppRow = opp as { id: string; account_id: string; deleted_at: string | null };
  if (oppRow.deleted_at) return { ok: false, error: "Opportunity has been deleted." };

  const { data: acct } = await sb
    .from("commercial_accounts")
    .select("id, deleted_at")
    .eq("id", oppRow.account_id)
    .maybeSingle();
  if (!acct || (acct as { deleted_at: string | null }).deleted_at) {
    return { ok: false, error: "Account has been deleted." };
  }

  return { ok: true, ctx: { opportunity_id: oppRow.id, account_id: oppRow.account_id } };
}

/**
 * Read-only variant used by list/get functions. Returns null instead of
 * a discriminated result because list paths swallow misses silently
 * (returning [] or null) — no user error surfaces from a list lookup.
 *
 * Use the editable-variant above for mutations so the error propagates.
 */
export async function loadOppContextOrNull(
  opportunity_id: string
): Promise<OppEditableContext | null> {
  const res = await verifyOppEditable(opportunity_id);
  return res.ok ? res.ctx : null;
}
