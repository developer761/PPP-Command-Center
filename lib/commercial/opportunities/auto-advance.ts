import "server-only";

import { commercialDb } from "@/lib/commercial/db";
import { advanceFromFilter } from "./constants";
import {
  AUTO_ADVANCE_TARGETS,
  type AutoAdvanceTargetKey,
  canAutoAdvance,
} from "./auto-advance-targets";
import { changeOpportunityStatus, type StatusChangeSource } from "./status";
import { etDateOf } from "@/lib/date-et";
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

  const { data: opp, error: readErr } = await sb
    .from("commercial_opportunities")
    .select("id, status, sub_status, status_user_set_at")
    .eq("id", input.oppId)
    .is("deleted_at", null)
    .maybeSingle();
  if (readErr && !isMissingGuardColumn(readErr.message)) {
    return { moved: false, reason: "error", detail: readErr.message };
  }
  // Migration 126 hasn't run yet: re-read without the column so the pipeline
  // keeps moving. Refusing everything here would silently freeze every
  // proposal-driven advance, with nothing but a log line to say why.
  const row = readErr
    ? await (async () => {
        console.warn(
          "[auto-advance] commercial_opportunities has no `status_user_set_at` — run migration 126. Advancing without the manual-override guard."
        );
        const { data } = await sb
          .from("commercial_opportunities")
          .select("id, status, sub_status")
          .eq("id", input.oppId)
          .is("deleted_at", null)
          .maybeSingle();
        return data as {
          status: string | null;
          sub_status: string | null;
          status_user_set_at?: string | null;
        } | null;
      })()
    : (opp as {
        status: string | null;
        sub_status: string | null;
        status_user_set_at?: string | null;
      } | null);
  if (!row) return { moved: false, reason: "missing" };
  const current = row;

  // Cheap check first: most calls are on deals already at or past the target,
  // so this saves the write entirely.
  if (!canAutoAdvance(current, input.target)) return { moved: false, reason: "not_behind" };

  if (humanDecidedMoreRecently(current.status_user_set_at ?? null, input.artifactAt ?? null)) {
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
    // Stamp the day the deal was actually decided, not the day the system got
    // around to noticing. `pre_sale_closed` is terminal, so an advance to Won
    // sets `decided_at` — and the dashboard reads that column raw to build its
    // win-rate denominator. A reconcile pass catching up months later would
    // otherwise drag an old win into this month and out of its own.
    decided_at_override: etDateOf(input.artifactAt),
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
 * The signal is `status_user_set_at` on the deal, not the status_log: a log row
 * is written only when the TOP-LEVEL status changes, so a person dragging a card
 * from the Proposal column back to Estimating — a sub-status-only move — leaves
 * the log empty and the guard blind.
 */
export function humanDecidedMoreRecently(
  statusUserSetAt: string | null,
  artifactAt: string | null
): boolean {
  if (!statusUserSetAt) return false;
  // No artifact time to compare against: any human decision outranks us.
  if (!artifactAt) return true;
  return new Date(statusUserSetAt).getTime() > new Date(artifactAt).getTime();
}

/** PostgREST's shape for "that column doesn't exist" (pre-migration-126). */
function isMissingGuardColumn(message: string): boolean {
  return /status_user_set_at/i.test(message);
}
