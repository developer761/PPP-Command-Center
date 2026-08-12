import "server-only";

import { commercialDb } from "@/lib/commercial/db";

/**
 * Remember the signed contract on the deal.
 *
 * Winning lives on the proposal, and a revision bump supersedes it — so within
 * one click of "New revision" on a won job, nothing in the proposals table says
 * $450k was ever agreed. This copies that number onto the opportunity while it
 * is still knowable.
 *
 * Called from the two places a win can actually happen (the audit found two, not
 * one): `changeOpportunityStatus` after its proposal cascade has run, and
 * `markProposalOutcome`, which deliberately skips the deal write when the deal
 * is already in delivery and would otherwise never trigger the first.
 *
 * Idempotent by design — `markProposalOutcome` reaches the deal writer twice for
 * a single click, and the reconciler can re-run on any page load. Re-running
 * only ever rewrites the snapshot when the WINNING PROPOSAL ITSELF changed,
 * which is the one case that should move a signed contract.
 */
export async function snapshotAcceptedContract(oppId: string): Promise<void> {
  const sb = commercialDb();

  // The live winning proposal. Largest total if somehow more than one, matching
  // how every other consumer of "the accepted proposal" disambiguates.
  const { data: propRows } = await sb
    .from("commercial_proposals")
    .select("id, total_cents, approved_at, updated_at")
    .eq("opportunity_id", oppId)
    .eq("status", "won")
    .is("deleted_at", null)
    .order("total_cents", { ascending: false })
    .limit(1);
  const won = (propRows ?? [])[0] as
    | { id: string; total_cents: number | string; approved_at: string | null; updated_at: string }
    | undefined;
  // No winning proposal to snapshot. Leave whatever is already there — this is
  // the state a re-quote creates, and clearing it here would delete the very
  // fact the column exists to preserve.
  if (!won) return;

  const cents = Number(won.total_cents) || 0;
  if (cents <= 0) return;

  const { data: oppRow, error: readErr } = await sb
    .from("commercial_opportunities")
    .select("accepted_contract_proposal_id, accepted_contract_cents")
    .eq("id", oppId)
    .maybeSingle();
  if (readErr) {
    if (isMissingSnapshotColumn(readErr.message)) {
      console.warn(
        "[accepted-contract] commercial_opportunities has no snapshot columns — run migration 127."
      );
      return;
    }
    console.warn("[accepted-contract] could not read the deal:", readErr.message);
    return;
  }
  const current = oppRow as {
    accepted_contract_proposal_id: string | null;
    accepted_contract_cents: number | string | null;
  } | null;

  // Already recording this exact proposal at this exact total — nothing to do.
  // This is what makes the double-fire and the reconciler harmless.
  if (
    current?.accepted_contract_proposal_id === won.id &&
    Number(current?.accepted_contract_cents ?? -1) === cents
  ) {
    return;
  }

  const { error } = await sb
    .from("commercial_opportunities")
    .update({
      accepted_contract_cents: cents,
      accepted_contract_proposal_id: won.id,
      // The moment the win happened, not the moment we noticed. A reconcile pass
      // catching up weeks later must not claim today's date.
      accepted_contract_set_at: won.approved_at ?? won.updated_at,
    })
    .eq("id", oppId);
  if (error && !isMissingSnapshotColumn(error.message)) {
    console.warn("[accepted-contract] snapshot write failed:", error.message);
  } else if (error) {
    console.warn(
      "[accepted-contract] commercial_opportunities has no snapshot columns — run migration 127."
    );
  }
}

/** PostgREST's shape for "that column doesn't exist" (pre-migration-127). */
function isMissingSnapshotColumn(message: string): boolean {
  return /accepted_contract/i.test(message);
}
