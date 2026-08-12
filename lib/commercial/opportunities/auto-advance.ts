import "server-only";

import { commercialDb } from "@/lib/commercial/db";
import { advanceFromFilter } from "./constants";
import {
  AUTO_ADVANCE_TARGETS,
  type AutoAdvanceTargetKey,
  canAutoAdvance,
} from "./auto-advance-targets";
import { changeOpportunityStatus, type StatusChangeSource } from "./status";
import type { OpportunityStatus } from "./db";

/**
 * The ONE path by which anything other than a person changes a deal's status.
 *
 * Before this existed there were six writers spread across the proposal
 * module, each with its own idea of when a deal should move, and they
 * disagreed: `createProposal` rewound a deal to Estimating on any revision
 * bump, while `reconcileDealStatesFromProposals` — which runs on every render
 * of the pipeline and proposals pages — read the highest-revision proposal and
 * moved the deal wherever that implied, in either direction. Open an R2 draft
 * on a deal at Proposal and the two would pull it back and forth, each swing
 * emailing the whole team.
 *
 * Every automatic move now goes through here, and the rule is forward-only:
 * a move happens if the deal is strictly behind the target, and not otherwise.
 * Backward correction is a human decision.
 */

export type AutoAdvanceOutcome =
  | { moved: true; from: { status: string; sub_status: string | null }; to: AutoAdvanceTargetKey }
  | {
      moved: false;
      reason: "not_behind" | "human_decided" | "guard" | "missing" | "error";
      detail?: string;
    };

export type AutoAdvanceInput = {
  oppId: string;
  target: AutoAdvanceTargetKey;
  /**
   * When the thing that justifies this move last changed (a proposal's
   * `updated_at`, a closeout package's completion time).
   *
   * Used to settle who is more current: if a person set the status AFTER this
   * artifact was touched, they were looking at it and chose something else, and
   * the engine defers. Omit only when there is no meaningful artifact time —
   * the guard then treats any human move as more current.
   */
  artifactAt?: string | null;
  /** Distinguishes an artifact-driven move from a drift-healing pass. */
  source: Exclude<StatusChangeSource, "user">;
  /** Why, in words a person reading the timeline would understand. */
  reason: string;
  /** Attributed on the audit row. The move is still recorded as non-`user`. */
  actingUserId?: string | null;
};

export async function autoAdvanceOpportunity(
  input: AutoAdvanceInput
): Promise<AutoAdvanceOutcome> {
  const target = AUTO_ADVANCE_TARGETS[input.target];
  const sb = commercialDb();

  const { data: opp } = await sb
    .from("commercial_opportunities")
    .select("id, status, sub_status")
    .eq("id", input.oppId)
    .is("deleted_at", null)
    .maybeSingle();
  if (!opp) return { moved: false, reason: "missing" };
  const current = opp as { status: string | null; sub_status: string | null };

  // Cheap check first: most calls are on deals already at or past the target,
  // and this saves both the log query and the write.
  if (!canAutoAdvance(current, input.target)) return { moved: false, reason: "not_behind" };

  if (await humanDecidedMoreRecently(input.oppId, input.artifactAt ?? null)) {
    return { moved: false, reason: "human_decided" };
  }

  // A refinement names its one legal source outright; a climb takes everything
  // behind it on the ladder. Either way the condition travels WITH the update,
  // so a person dragging the same card right now wins the race.
  const requireFrom = target.exactFrom
    ? `and(status.eq.${target.exactFrom.status},sub_status.eq.${target.exactFrom.sub_status})`
    : advanceFromFilter(target.status, target.sub_status);

  const res = await changeOpportunityStatus({
    opp_id: input.oppId,
    to_status: target.status as OpportunityStatus,
    to_sub_status: target.sub_status,
    acting_user_id: input.actingUserId ?? null,
    source: input.source,
    note: input.reason,
    _requireFrom: requireFrom,
    // Strictly deal-side. Cascading back to the proposals would move cards
    // nobody touched, and re-entering this engine from inside itself is how a
    // single edit turns into a chain of writes.
    _skipProposalCascade: true,
    _skipDagCheck: true,
  });

  if (!res.ok) return { moved: false, reason: "error", detail: res.error };
  if (res.skipped === "guard") return { moved: false, reason: "guard" };
  return {
    moved: true,
    from: { status: current.status ?? "", sub_status: current.sub_status },
    to: input.target,
  };
}

/**
 * Did a person set this deal's status after the triggering artifact changed?
 *
 * Forward-only alone doesn't cover this. An admin who re-qualifies a deal that
 * had reached Proposal has moved it BACKWARDS on purpose; the next reconcile
 * pass would then find it legitimately behind the still-`sent` proposal and
 * shove it forward again, undoing them on a page load they didn't even make.
 *
 * `source = 'user'` is the signal (migration 126), not `changed_by_user_id`:
 * proposal cascades run inside a human's request and carry that human's id, so
 * the actor column can't tell a person's decision from the system's.
 */
async function humanDecidedMoreRecently(oppId: string, artifactAt: string | null): Promise<boolean> {
  const sb = commercialDb();
  const { data, error } = await sb
    .from("commercial_opportunity_status_log")
    .select("changed_at")
    .eq("opportunity_id", oppId)
    .eq("source", "user")
    .order("changed_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  // Reading the guard failed — refuse the move. Skipping an advance leaves a
  // deal a stage behind until someone drags it; guessing wrong overwrites a
  // decision a person made, which nobody sees happen.
  if (error) {
    console.warn("[auto-advance] could not read status_log; refusing to move:", error.message);
    return true;
  }
  const lastHuman = (data as { changed_at: string } | null)?.changed_at;
  if (!lastHuman) return false;
  // No artifact time to compare against: any human decision outranks us.
  if (!artifactAt) return true;
  return new Date(lastHuman).getTime() > new Date(artifactAt).getTime();
}
