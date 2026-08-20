import "server-only";

import { commercialDb } from "@/lib/commercial/db";
import { logUpdate, logInsert } from "@/lib/commercial/audit-log";
import { etTodayIso } from "@/lib/date-et";
import { insertCommercialOppStatusChangedNotifications } from "@/lib/notifications/commercial-events";
import {
  ALLOWED_TRANSITIONS,
  DEFAULT_PROBABILITY_BY_SUB_STATUS,
  DEFAULT_SUB_STATUS_BY_STATUS,
  PROBABILITY_PRESERVING_SUB_STATUSES,
  TERMINAL_STATUSES,
  PRE_SALE_OPEN_STATUSES,
  IN_DELIVERY_STATUSES,
  WARN_TRANSITIONS,
  isValidSubStatus,
  isLost,
} from "./constants";
import { projectStateForOpportunity } from "@/lib/commercial/projects/ensure";
import {
  type CommercialOpportunity,
  type OpportunityStatus,
  type OpportunityLossReason,
  OPPORTUNITY_LOSS_REASONS,
  opportunityStatusLabel,
  derivedOppName,
} from "./db";
import { personName } from "@/lib/commercial/person-name";

/**
 * Status-transition orchestration for commercial_opportunities.
 *
 * `changeOpportunityStatus` is the ONLY way an opp.status mutates after
 * create. It enforces the DAG, captures a status_log row, auto-sets
 * decided_at / clears loss_reason / conditionally updates probability,
 * and audit-logs everything via the existing helpers.
 *
 * Migration 029 must be applied before this lib's writes succeed
 * (status_log table doesn't exist before then). The transaction is
 * sequential write-then-write; on Supabase that's two round-trips
 * but they're both fast and the worst-case partial state is a status
 * change with no log row, which manual cleanup can handle.
 */

/** Return the list of statuses a user can transition to from `from`,
 *  filtered by the DAG. Used by the UI to render only valid next
 *  options in the quick-flip dropdown. */
export function allowedNextStatuses(from: OpportunityStatus): ReadonlyArray<OpportunityStatus> {
  return (ALLOWED_TRANSITIONS[from] ?? []) as ReadonlyArray<OpportunityStatus>;
}

/** List of statuses the Kanban / list "Move to…" dropdown offers.
 *  Karan 2026-07-15 (later): "let me move the kanban freely." The
 *  extra narrowing on pre_sale_closed is gone — dropdown now offers
 *  every allowed next status (which since the DAG went flat is
 *  every OTHER status). WARN_TRANSITIONS still tags unusual jumps
 *  with a soft "are-you-sure" hint. */
export function quickFlipNextStatuses(
  from: OpportunityStatus
): ReadonlyArray<OpportunityStatus> {
  return allowedNextStatuses(from);
}

/** Is `from → to` a valid DAG transition? Returns false for unknown
 *  statuses too (defense in depth). */
export function isTransitionAllowed(from: OpportunityStatus, to: OpportunityStatus): boolean {
  const allowed = ALLOWED_TRANSITIONS[from];
  if (!allowed) return false;
  return allowed.includes(to);
}

/** Should the UI render a "are you sure?" warning before executing this
 *  transition? Lib accepts the change regardless — the warning is UX. */
export function shouldWarnTransition(from: OpportunityStatus, to: OpportunityStatus): boolean {
  return WARN_TRANSITIONS.has(`${from}→${to}`);
}

export type ChangeStatusInput = {
  opp_id: string;
  to_status: OpportunityStatus;
  /** Karan 2026-07-15 (round 5): the DAG check is BACK by default so
   *  users can't skip multi-step backward (In Progress → Estimating
   *  is nonsense). But internal cascades (proposal→deal auto-align,
   *  admin reconciles) need to bypass so the alignment engine can
   *  move any deal to any target without user-facing validation. */
  _skipDagCheck?: boolean;
  /** Karan 2026-07-15 (round 6): when a cascade FROM a proposal move
   *  fires this deal update, we must NOT let the deal update then
   *  cascade BACK to sibling proposals — that promotes/demotes cards
   *  the user never touched, making the proposal kanban look like
   *  "everything moves as one." Set true from the proposal→deal
   *  cascade path in updateProposalStatus. */
  _skipProposalCascade?: boolean;
  /** v2 (migration 052): callers should pass the target sub_status too so
   *  the tuple lands whitelisted. If omitted, the DEFAULT_SUB_STATUS_BY_STATUS
   *  fallback for `to_status` is used (e.g. proposal → sent). */
  to_sub_status?: string | null;
  acting_user_id: string | null;
  /** Free-form note. Required (non-empty) when the closure is a Lost. */
  note?: string | null;
  /** Required (non-null) when the closure is a Lost. */
  loss_reason?: OpportunityLossReason | null;
  /** Phase E-4 (2026-07-13): optional follow-up scheduling on the same
   *  transition. Undefined = don't touch. null = clear. Set only when
   *  the caller wants the user's choice (e.g., picker showed the
   *  follow-up fields and got a value) to overwrite the DB row. */
  follow_up_at?: string | null | undefined;
  follow_up_notes?: string | null | undefined;
  /**
   * WHO decided this — a person, or the system acting on an artifact.
   *
   * Recorded on the status_log row (migration 126) because it cannot be
   * inferred afterwards: every proposal cascade runs inside a human's request
   * and passes that human's `acting_user_id`, so the actor column says
   * "a person" for automatic moves too. The auto-advance engine reads this back
   * to avoid undoing a decision someone actually made.
   *
   * Non-`user` sources also skip the team fan-out — nobody needs an email
   * saying the system agreed with a proposal they just sent.
   *
   * Defaults to `user`: an unmarked caller is a person, which is the reading
   * that makes the engine cautious rather than eager.
   */
  source?: StatusChangeSource;
  /**
   * Forward-only guard, as a PostgREST filter over the states this move may
   * start from (build it with `advanceFromFilter`).
   *
   * Applied to the UPDATE itself so the DATABASE enforces monotonicity: a
   * human dragging the same card at the same moment can't be clobbered by a
   * check that passed a few milliseconds earlier. Zero rows matched is a
   * successful no-op, reported as `skipped: "guard"`.
   */
  _requireFrom?: string;
  /**
   * The ET calendar date (YYYY-MM-DD) this decision was actually made, when
   * that isn't today.
   *
   * `decided_at` otherwise gets stamped with today's date on any move into a
   * terminal status. That's right for a person clicking Won now, and wrong for
   * an automatic move catching up months later — the dashboard builds its
   * win-rate denominator from raw `decided_at`, so a late catch-up would drag
   * an old win into this month and out of the month it belongs to.
   */
  decided_at_override?: string | null;
};

/** @see ChangeStatusInput.source */
export type StatusChangeSource = "user" | "auto_advance" | "reconcile";

export async function changeOpportunityStatus(
  input: ChangeStatusInput
): Promise<
  | { ok: true; opportunity: CommercialOpportunity; skipped?: "guard" }
  | { ok: false; error: string }
> {
  const sb = commercialDb();

  // Fetch the current opp (with soft-delete guard).
  const { data: before } = await sb
    .from("commercial_opportunities")
    .select("*")
    .eq("id", input.opp_id)
    .is("deleted_at", null)
    .maybeSingle();
  if (!before) return { ok: false, error: "Opportunity not found." };
  const beforeRow = before as CommercialOpportunity;

  // Karan 2026-07-16 (round 2 bug hunt): compute the EFFECTIVE
  // sub_status (default for the target status if caller passes
  // undefined) BEFORE the no-op check. Otherwise dragging Proposal
  // Drafted → Estimating (no explicit sub) hits the "same top-level"
  // early-out and no-ops, when it should actually reset sub_status
  // to the default ("estimating"). Same root cause as the earlier
  // sub-only cascade fix — this is the un-passed-sub_status case.
  const effectiveSubStatus =
    input.to_sub_status !== undefined && input.to_sub_status !== null
      ? input.to_sub_status
      : ((DEFAULT_SUB_STATUS_BY_STATUS as Record<string, string>)[input.to_status] ?? null);
  if (
    beforeRow.status === input.to_status &&
    beforeRow.sub_status === effectiveSubStatus
  ) {
    return { ok: true, opportunity: beforeRow };
  }

  // Defense-in-depth: refuse to transition an opp belonging to a
  // soft-deleted account. The opp itself might not be soft-deleted but
  // its parent could've been deleted between page load and submit.
  const { data: account } = await sb
    .from("commercial_accounts")
    .select("id, deleted_at")
    .eq("id", beforeRow.account_id)
    .maybeSingle();
  if (!account || account.deleted_at) {
    return { ok: false, error: "Account not found." };
  }

  // Karan 2026-07-15 (round 5): DAG check IS BACK — but only for
  // user-facing status changes, not internal cascades. Blocks nonsense
  // multi-step backward jumps (In Progress → Estimating). Allowed
  // transitions: see ALLOWED_TRANSITIONS in constants.ts. Cascades
  // pass _skipDagCheck=true to bypass — the alignment engine must be
  // free to move any deal to any target when correcting drift.
  //
  // Structural-fields guard + Won-with-invoices guard stay OFF per
  // Karan's earlier "no constraints" (only the DAG is being restored,
  // not the field-validation gates). Lost still requires loss_reason
  // + note as input validation.
  //
  // DB CHECK constraints stay dropped (migration 059).
  if (!input._skipDagCheck) {
    // Karan 2026-07-16: skip DAG when only the sub_status is changing.
    // ALL_STATUSES_EXCEPT excludes self, so estimating → estimating (with
    // a different sub_status) would be REJECTED — but sub-status
    // refinements within the same top-level stage are always valid.
    if (beforeRow.status !== input.to_status) {
      const allowed = ALLOWED_TRANSITIONS[beforeRow.status] ?? [];
      if (!allowed.includes(input.to_status)) {
        return {
          ok: false,
          error: `Can't move from ${opportunityStatusLabel(beforeRow.status)} → ${opportunityStatusLabel(input.to_status)} directly. Move through an intermediate stage first.`,
        };
      }
    }
  }
  const targetIsLost =
    input.to_status === "pre_sale_closed" && input.to_sub_status === "lost";

  // Loss-reason enforcement when the closure is a Lost.
  // v2 (migration 052): "Lost" is Pre-Sale/Closed/Lost — i.e. status =
  // pre_sale_closed AND sub_status = lost.
  //
  // Karan 2026-07-15 (round 5): cascade paths bypass this validation
  // and auto-inject a placeholder loss_reason/note. Otherwise a
  // proposal dragged to Lost never cascades to the deal — the debrief
  // form is the only path that collects loss_reason, and until the
  // user completes it the two surfaces would sit misaligned. The
  // placeholder gets overwritten when the user completes the debrief.
  let lossReason: OpportunityLossReason | null = null;
  let lossNote: string | null = null;
  if (targetIsLost) {
    if (input._skipDagCheck) {
      // Cascade path — auto-populate so the deal can flip. User is
      // expected to complete the debrief form separately to overwrite
      // these placeholders with the real reason.
      lossReason = "other";
      lossNote = "Auto-set by cascade — complete the debrief form to record the real reason.";
    } else {
      if (!input.loss_reason || !OPPORTUNITY_LOSS_REASONS.includes(input.loss_reason)) {
        return {
          ok: false,
          error: "Pick a reason for losing (or `no_bid` if we declined to bid).",
        };
      }
      // The NOTE is not required. It used to hard-reject an empty one, but the
      // only field feeding it is labelled "(optional)" on the form (the
      // dedicated loss-note field was removed in 2026-06-24 and this check
      // stayed), so marking a deal Lost from the deal page was a dead end: the
      // deal didn't move, the error named a field that wasn't on screen, and
      // the user's picks were discarded on the reload. The structured
      // `loss_reason` above is the part the reports actually read, and it IS
      // still required. Per the never-reject rule, a missing note records a
      // marker instead of blocking the move.
      lossReason = input.loss_reason;
      lossNote = input.note?.trim() || "No note recorded.";
    }
  }

  // Decide probability_pct for the patch:
  // - If the user overrode the prior status's default (current pct
  //   isn't equal to the default for the from status), KEEP the
  //   override — they meant it.
  // - If transitioning INTO a probability-preserving status
  //   (follow_up in v1.1), keep the current value regardless — waiting
  //   on the customer doesn't change how likely you are to win.
  // - Otherwise auto-set to the new status's default.
  // 2026-07-28 re-audit: probability tracks the SUB-STATUS in v2. This used the
  // deprecated DEFAULT_PROBABILITY_BY_STATUS shim, which maps Estimating → 55
  // (the proposal_pending_approval value) instead of the Estimating sub-status
  // default 30 — so every deal being priced was over-weighted, inflating the
  // weighted pipeline. Key off the resolved sub-status instead.
  const fromDefault = DEFAULT_PROBABILITY_BY_SUB_STATUS[beforeRow.sub_status ?? ""] ?? null;
  const userOverrode = fromDefault !== null && beforeRow.probability_pct !== fromDefault;
  const preserveProbability = PROBABILITY_PRESERVING_SUB_STATUSES.has(effectiveSubStatus ?? "");
  const nextProbability =
    userOverrode || preserveProbability
      ? beforeRow.probability_pct
      : DEFAULT_PROBABILITY_BY_SUB_STATUS[effectiveSubStatus ?? ""] ?? beforeRow.probability_pct;

  // decided_at auto-management: set today when entering a terminal
  // state (won/lost); CLEAR only on a genuine REOPEN back to the active
  // pre-sale pipeline.
  //
  // 2026-07-29 re-audit fix: advancing a WON deal into post-sale delivery
  // (pre_sale_closed+won → pre_construction / in_progress / billing) is
  // terminal→non-terminal, but it is NOT a reopen — the deal is still won.
  // Clearing decided_at there made a just-won job vanish from "Wins this
  // month" and (via the debrief-flag clear below) falsely reappear under
  // "Awaiting debrief." Only clear when the destination is an ACTIVE
  // pre-sale status (qualifying/estimating/proposal).
  const wasTerminal = TERMINAL_STATUSES.has(beforeRow.status);
  const isTerminal = TERMINAL_STATUSES.has(input.to_status);
  const reopensToPipeline =
    wasTerminal && PRE_SALE_OPEN_STATUSES.includes(input.to_status);

  // ── decided_at: the day this deal was WON or LOST ───────────────────────
  //
  // One meaning, for the whole life of a deal. It is what "Wins this month"
  // counts and what the dashboard's win-rate denominator reads, and it used to
  // be wrong in four separate ways that were really one: it was stamped on
  // entry to any TERMINAL status, and it was stamped only then.
  //
  //   * Close-out is terminal, so finishing the paperwork overwrote the win
  //     date — a March win became an August one. Close-out now has its own
  //     column (migration 129) and never touches this.
  //   * A verbal yes dragged straight from Proposal into a delivery column
  //     never passed through a terminal status at all, so the win was never
  //     dated and vanished from both the count and the rate.
  //   * A lost→won re-decision moves between two sub-statuses of the same
  //     terminal status, so it kept the date of the original wrong call.
  //   * And a reopen out of close-out left the close-out date sitting there,
  //     which then counted as a win in the wrong month.
  //
  // The date the deal was DECIDED, stamped when it is first decided and
  // restamped only if that decision changes. An automatic move supplies the day
  // the triggering thing happened; a person deciding now defaults to today.
  const decidedNow = input.decided_at_override ?? etTodayIso();
  const toPreSaleClosed = input.to_status === "pre_sale_closed";
  const wasPreSaleClosed = beforeRow.status === "pre_sale_closed";
  const toInDelivery =
    IN_DELIVERY_STATUSES.includes(input.to_status) || input.to_status === "post_sale_closed";

  let nextDecidedAt: string | null | undefined = undefined; // undefined = don't touch
  if (toPreSaleClosed && (!wasPreSaleClosed || beforeRow.sub_status !== effectiveSubStatus)) {
    // Won or lost — first time, or the call changed.
    nextDecidedAt = decidedNow;
  } else if (toInDelivery && !beforeRow.decided_at) {
    // Straight into delivery on a verbal yes, never formally closed. The work
    // starting IS the decision; without this the win is never counted at all.
    nextDecidedAt = decidedNow;
  } else if (reopensToPipeline) {
    // Genuinely back in the pipeline — undecided again.
    nextDecidedAt = null;
  }

  // ── closed_out_at: the day the job finished ─────────────────────────────
  // Its own column precisely so it can never be mistaken for the win date.
  const toClosedOut = input.to_status === "post_sale_closed";
  const wasClosedOut = beforeRow.status === "post_sale_closed";
  let nextClosedOutAt: string | null | undefined = undefined;
  if (toClosedOut && !wasClosedOut) nextClosedOutAt = decidedNow;
  else if (wasClosedOut && !toClosedOut) nextClosedOutAt = null; // reopened

  // Loss tracking: clear loss_reason + loss_notes when LEAVING lost.
  // Set them inline (rather than two separate updates) when entering.
  // v2 (migration 052): patch BOTH status and sub_status.
  // If caller didn't supply to_sub_status, fall back to the default
  // sub-status for the target status. The DB CHECK will reject any
  // (status, sub_status) tuple that's not whitelisted so the fallback
  // must be internally consistent.
  const nextSubStatus =
    input.to_sub_status && isValidSubStatus(input.to_status, input.to_sub_status)
      ? input.to_sub_status
      : ((DEFAULT_SUB_STATUS_BY_STATUS as Record<string, string>)[input.to_status] ??
        "rfp");
  const patch: Record<string, unknown> = {
    status: input.to_status,
    sub_status: nextSubStatus,
    probability_pct: nextProbability,
    updated_by_user_id: input.acting_user_id ?? null,
  };
  // Stamp WHEN a person last set this deal's status, so the auto-advance engine
  // can tell a human decision from its own work. It can't read that off the
  // status_log: a log row is only written when the TOP-LEVEL status changes, so
  // a drag from the Proposal column back to Estimating — a sub-status-only
  // move — would leave no trace and get silently undone on the next render.
  if ((input.source ?? "user") === "user") patch.status_user_set_at = new Date().toISOString();
  if (nextDecidedAt !== undefined) patch.decided_at = nextDecidedAt;
  if (nextClosedOutAt !== undefined) patch.closed_out_at = nextClosedOutAt;
  if (targetIsLost) {
    patch.loss_reason = lossReason;
    patch.loss_notes = lossNote;
  } else if (isLost(beforeRow)) {
    patch.loss_reason = null;
    patch.loss_notes = null;
  }
  // Phase E-4: follow-up scheduling. If caller passed a value, write it.
  // On transition INTO a terminal state, always clear the reminder — a
  // closed deal shouldn't stay on any follow-up list.
  if (input.follow_up_at !== undefined) patch.follow_up_at = input.follow_up_at;
  if (input.follow_up_notes !== undefined)
    patch.follow_up_notes = input.follow_up_notes?.slice(0, 200) ?? null;
  if (isTerminal && !wasTerminal) {
    patch.follow_up_at = null;
    patch.follow_up_notes = null;
  }

  let q = sb.from("commercial_opportunities").update(patch).eq("id", input.opp_id);
  // The forward-only guard rides on the UPDATE rather than sitting in front of
  // it, so the database is the one deciding whether this move is still legal.
  if (input._requireFrom) q = q.or(input._requireFrom);
  let { data: after, error: updateErr } = await q.select("*").maybeSingle();
  // Pre-migration-126/129 safety net. Two of the three paths that touch those
  // columns already degrade; THIS one didn't — and it is the human path, so
  // deploying ahead of the migrations would reject every manual status change
  // (kanban drag, status dropdown, win/loss close) with "column does not
  // exist". That is strictly worse than before the columns were introduced:
  // status changes used to work. Drop the new columns and retry once.
  if (updateErr && /status_user_set_at|closed_out_at/i.test(updateErr.message)) {
    console.warn(
      "[commercial/opportunities/status] opportunities table is missing a status column — run migrations 126 and 129. Writing without them."
    );
    delete patch.status_user_set_at;
    delete patch.closed_out_at;
    let retry = sb.from("commercial_opportunities").update(patch).eq("id", input.opp_id);
    if (input._requireFrom) retry = retry.or(input._requireFrom);
    ({ data: after, error: updateErr } = await retry.select("*").maybeSingle());
  }
  if (updateErr) return { ok: false, error: updateErr.message };
  // No row matched: the deal moved on between the read and the write, or it was
  // already at least this far along. Nothing to do, and nothing went wrong.
  if (!after) return { ok: true, opportunity: beforeRow, skipped: "guard" };
  const updated = after as CommercialOpportunity;

  // Append the status_log row — ONLY for real top-level status changes.
  // Sub-status-only refinements (e.g. Estimating → Proposal Drafted)
  // still write the sub_status via the update above but don't add a
  // status_log entry (would be from_status == to_status, meaningless
  // noise in the timeline). Audit-log still captures the row diff.
  if (beforeRow.status !== input.to_status) {
    const logPayload: Record<string, unknown> = {
      opportunity_id: input.opp_id,
      from_status: beforeRow.status,
      to_status: input.to_status,
      changed_by_user_id: input.acting_user_id ?? null,
      source: input.source ?? "user",
      note: input.note?.trim() || null,
      loss_reason: lossReason,
    };
    let { data: logRow, error: logErr } = await sb
      .from("commercial_opportunity_status_log")
      .insert(logPayload)
      .select("*")
      .single();
    // Deploying this code before migration 126 runs would otherwise drop EVERY
    // timeline row on the floor — the insert fails on the unknown `source`
    // column, the warning goes to a log nobody is reading, and the status change
    // itself still succeeds. Those rows can't be reconstructed afterwards, and
    // they carry the timeline, "days in current status", recent activity and
    // the win/loss debrief's foreign key. Retry without the new column so the
    // history survives the gap.
    if (logErr && /source/i.test(logErr.message)) {
      console.warn(
        "[commercial/opportunities/status] status_log has no `source` column — run migration 126. Logging without it."
      );
      delete logPayload.source;
      ({ data: logRow, error: logErr } = await sb
        .from("commercial_opportunity_status_log")
        .insert(logPayload)
        .select("*")
        .single());
    }
    if (logErr) {
      console.warn(
        "[commercial/opportunities/status] status_log insert failed:",
        logErr.message
      );
    } else if (logRow) {
      await logInsert(
        "commercial_opportunity_status_log",
        (logRow as { id: string }).id,
        logRow,
        input.acting_user_id
      );
    }
  }

  // Audit the opp update with the full before/after snapshot.
  await logUpdate(
    "commercial_opportunities",
    input.opp_id,
    beforeRow,
    updated,
    input.acting_user_id
  );

  // Karan 2026-07-15 (round 5): FULL bidirectional cascade — every deal
  // state change syncs child proposals to the matching state so both
  // surfaces always stay locked. Previously only pre_sale_closed
  // transitions cascaded; user-facing symptom: dragging deal
  // Sent → Drafted on the opp kanban would work, then reconcile
  // would yank it back on next page load (proposal still Sent).
  //
  // Full mapping (deal → intent for child proposals):
  //   qualifying                                         → demote sent/pending/won/lost proposals back to draft
  //   estimating + sub=estimating                        → demote sent proposals back to draft (re-pricing)
  //   estimating + sub=proposal_pending_approval         → sent/won/lost → pending_approval; drafts stay
  //   proposal + sub=sent (or follow_up)                 → draft/pending → sent; won/lost → sent (reopen)
  //   pre_sale_closed + sub=won                          → sent → won
  //   pre_sale_closed + sub=lost                         → sent → lost
  //   pre_construction / in_progress / billing / post_sale_closed
  //                                                       → no cascade (delivery-phase, proposals are historical)
  //
  // Anti-ping-pong: passes _skipOppCascade=true to
  // updateProposalStatus so the proposal-side cascade doesn't call
  // back into this function and infinite-loop.
  //
  // Best-effort — failures log a warning but never roll back the opp
  // update.
  // Karan 2026-07-15 (round 6): the proposal cascade block below fans
  // out to sibling proposals on the same deal. That's correct when
  // the DEAL was moved (e.g., user drags deal to Won → all Sent
  // proposals should become Won). It's WRONG when this deal update
  // was itself triggered BY a proposal move — the sibling proposals
  // aren't touched by the user's intent and shouldn't be dragged
  // along. Caller signals this via _skipProposalCascade.
  if (!input._skipProposalCascade) {
   try {
    const deriveTargetProposalStatus = (): {
      demoteFrom: string[];
      to: string;
    } | null => {
      const s = input.to_status;
      const sub = input.to_sub_status;
      if (s === "qualifying") {
        return {
          demoteFrom: ["pending_approval", "approved", "sent", "won", "lost"],
          to: "draft",
        };
      }
      if (s === "estimating" && sub !== "proposal_pending_approval") {
        // Karan 2026-07-16: also demote pending_approval → draft so a
        // manual deal move from "Proposal Drafted" back to plain
        // Estimating actually rewinds the proposal state (otherwise
        // reconcile pulls the deal forward again on next page load).
        // `approved` belongs here too. Without it, dragging a card from the
        // Proposal column back to Estimating left the proposal `approved`, and
        // the next page load read that proposal and snapped the deal forward
        // again — the bounce-back, on someone else's render, with no timeline
        // row to explain it (the drag changed only the sub-status, so it
        // wrote none).
        return { demoteFrom: ["pending_approval", "approved", "sent", "won", "lost"], to: "draft" };
      }
      if (s === "estimating" && sub === "proposal_pending_approval") {
        // Add draft to the promote-from set so manually flipping the
        // deal to "Proposal Drafted" also flips the current draft to
        // pending_approval (they represent the same moment in the flow).
        return { demoteFrom: ["draft", "approved", "sent", "won", "lost"], to: "pending_approval" };
      }
      if (s === "proposal") {
        // R1d HARD GATE (Karan 2026-08): the deal-axis cascade must NOT
        // promote a pre-send proposal (draft / pending_approval / approved)
        // to `sent`. `sent` has side effects — approval enforcement, the
        // frozen PDF snapshot, the team/exclusion notifications — that only
        // `sendProposal` performs; a bare status flip here would mark a
        // proposal "sent" with no PDF and nobody notified, AND skip the
        // approval gate entirely (drag the DEAL to Proposal·Sent → unapproved
        // proposal silently becomes sent). So we only demote a CLOSED
        // proposal (won/lost) back to sent when the deal moves back; a
        // pre-send proposal is left untouched (reconcile will pull the deal
        // back into Estimating until the real Send happens).
        return { demoteFrom: ["won", "lost"], to: "sent" };
      }
      // Karan 2026-07-16 (round 2): Won and Lost pull the CURRENT
      // proposal to Won/Lost from ANY state (draft/pending/sent/lost/won).
      // Prior narrower [sent] set meant flipping a deal Won while the
      // proposal was still Draft did nothing on the proposal side,
      // leaving the column mismatch Karan flagged.
      if (s === "pre_sale_closed" && sub === "won") {
        return {
          demoteFrom: ["draft", "pending_approval", "approved", "sent", "lost"],
          to: "won",
        };
      }
      if (s === "pre_sale_closed" && sub === "lost") {
        return {
          demoteFrom: ["draft", "pending_approval", "approved", "sent", "won"],
          to: "lost",
        };
      }
      // Karan 2026-07-16 spec: Pre-Con / In-Prog / Billing → proposal
      // stays in Sent. If the user manually moves a deal into delivery
      // from ANY prior state, the current proposal should land in Sent
      // (the "we have a signed bid + crew is executing" state). This
      // demotes a Draft/Pending/Won/Lost proposal to Sent on that
      // transition, matching Karan's canonical map.
      if (s === "pre_construction" || s === "in_progress" || s === "billing") {
        // Same R1d gate as the `proposal` case above: never promote a
        // pre-send proposal to `sent` via the deal cascade (that would skip
        // approval + the PDF snapshot + notifications). Only re-align a
        // closed proposal (won/lost) to sent when the deal is moved into
        // delivery from a closed state.
        return {
          demoteFrom: ["won", "lost"],
          to: "sent",
        };
      }
      // Post-sale closed (project fully done): proposals aren't
      // touched — they're historical records at this point.
      return null;
    };
    const target = deriveTargetProposalStatus();
    if (target) {
      const { updateProposalStatus, requestProposalApproval } = await import(
        "@/lib/commercial/proposals/db"
      );
      // Karan 2026-07-15 (Option A): cascade only affects the LATEST
      // revision on this deal, not every sibling in demoteFrom set.
      // Rationale: multiple revisions exist because Alex bumped
      // through negotiation rounds — R11 is the active one, R1-R10
      // are history. When the deal moves to Won/Lost/Sent/Drafted,
      // only R11 should follow. R1-R10 stay as-is (usually already
      // Replaced/Superseded).
      //
      // Query all proposals on this deal in demoteFrom, then keep
      // only the highest revision_number one.
      const { data: propRows } = await sb
        .from("commercial_proposals")
        .select("id, status, revision_number")
        .eq("opportunity_id", input.opp_id)
        .is("deleted_at", null)
        .in("status", target.demoteFrom)
        .order("revision_number", { ascending: false })
        .limit(1);
      const proposals =
        (propRows as { id: string; status: string; revision_number: number }[] | null) ?? [];
      for (const p of proposals) {
        if (p.status === target.to) continue;
        // Dragging a deal to "Proposal Drafted" flips its DRAFT proposal to
        // pending_approval — route that through requestProposalApproval (not the
        // bare status flip) so the ≥1-inclusion guard runs, the requester is
        // stamped, AND the designated approver actually gets the "please approve"
        // bell + email. A bare updateProposalStatus left approvers un-notified,
        // so an approval could sit silently forever (audit #14).
        if (target.to === "pending_approval" && p.status === "draft" && input.acting_user_id) {
          const req = await requestProposalApproval({
            proposal_id: p.id,
            actor_user_id: input.acting_user_id,
          });
          if (!req.ok) {
            console.warn(
              `[changeOpportunityStatus] approval-request cascade failed for ${p.id} (opp ${input.opp_id}): ${req.error}`
            );
          }
          continue;
        }
        const flip = await updateProposalStatus({
          id: p.id,
          to_status: target.to as Parameters<typeof updateProposalStatus>[0]["to_status"],
          acting_user_id: input.acting_user_id,
          _skipOppCascade: true,
        });
        if (!flip.ok) {
          console.warn(
            `[changeOpportunityStatus] proposal cascade failed for ${p.id} (opp ${input.opp_id}): ${flip.error}`
          );
        }
      }
    }
  } catch (err) {
    console.warn(
      "[changeOpportunityStatus] proposal cascade threw:",
      err instanceof Error ? err.message : String(err)
    );
  }
  }

  // Remember the signed contract on the deal, AFTER the proposal cascade — the
  // cascade is what flips the current proposal to `won`, so running this before
  // it would find nothing to snapshot. Winning is recorded on the proposal, and
  // the next revision supersedes it; without this the agreed number is gone the
  // moment someone re-quotes the job.
  if (input.to_status === "pre_sale_closed" && nextSubStatus === "won") {
    try {
      const { snapshotAcceptedContract } = await import(
        "@/lib/commercial/projects/accepted-contract"
      );
      await snapshotAcceptedContract(input.opp_id);
    } catch (err) {
      console.warn(
        "[changeOpportunityStatus] accepted-contract snapshot threw:",
        err instanceof Error ? err.message : String(err)
      );
    }
  }

  // ── The PROJECT half of the job (migration 131) ─────────────────────────
  //
  // Winning creates the project. It hangs off THIS function rather than the
  // won-status branch above because that branch only sees a formal close: seven
  // of the nine real deals reached delivery without one, and a deal dragged
  // straight from Proposal into In Progress never passes through `won` at all.
  // `projectStateForOpportunity` owns that rule; here we only decide whether it
  // is worth asking.
  //
  // Runs AFTER the accepted-contract snapshot on purpose — the snapshot is what
  // the project reads to learn its contract figure.
  //
  // Best-effort: a job must never fail to be marked won because its project row
  // couldn't be written. Idempotent, so the next status change re-attempts.
  {
    const wasProjectBearing = projectStateForOpportunity(
      beforeRow.status,
      beforeRow.sub_status
    ).shouldExist;
    const isProjectBearing = projectStateForOpportunity(
      input.to_status,
      nextSubStatus
    ).shouldExist;
    // The `was` case matters as much as the `is` case: that is the un-win, and
    // it archives the project rather than leaving it live on a deal that is no
    // longer won.
    if (isProjectBearing || wasProjectBearing) {
      try {
        const { ensureProjectForOpportunity } = await import(
          "@/lib/commercial/projects/ensure"
        );
        const res = await ensureProjectForOpportunity(input.opp_id, {
          actingUserId: input.acting_user_id,
        });
        if (!res.ok) {
          console.warn("[changeOpportunityStatus] project ensure failed:", res.error);
        }
      } catch (err) {
        console.warn(
          "[changeOpportunityStatus] project ensure threw:",
          err instanceof Error ? err.message : String(err)
        );
      }
    }
  }

  // Fan out a bell + email to every active team member on the opp
  // (minus the actor). Fire-and-forget — never blocks the status flip.
  // Helper handles the self-skip + inactive-skip + fanout query.
  //
  // Gated on a REAL top-level move, matching the status_log rule above. A
  // sub-status refinement (Proposal · Sent → Proposal · Follow-Up) otherwise
  // emailed the whole team "moved status from Proposal" → "Proposal" — a
  // notification about nothing. Newly reachable now that the detail-page
  // picker offers the current status so sub-statuses can be edited at all.
  //
  // Also gated on a PERSON having made the move. The reconciler passes a null
  // actor, so every drift-heal fanned out to the whole team as "PPP admin moved
  // this deal" — and paired with the ping-pong that was two waves of bells per
  // cycle, triggered by whoever merely loaded the pipeline page. The system
  // agreeing with a proposal someone just sent is not news.
  const isRealStatusMove =
    beforeRow.status !== input.to_status && (input.source ?? "user") === "user";
  if (isRealStatusMove) void (async () => {
    try {
      let actorName = "PPP admin";
      if (input.acting_user_id) {
        const { data: actor } = await sb
          .from("profiles")
          .select("sf_user_name, email")
          .eq("user_id", input.acting_user_id)
          .maybeSingle();
        const a = actor as { sf_user_name?: string | null; email?: string | null } | null;
        actorName = personName(a?.sf_user_name, a?.email, "PPP admin");
      }
      // Phase B: compute the derived opp name (account - client - location)
      // for the bell + email body so users see the CEO's standardized
      // format, not the raw stored `title` field.
      let accountName: string | null = null;
      if (updated.account_id) {
        const { data: acct } = await sb
          .from("commercial_accounts")
          .select("company_name")
          .eq("id", updated.account_id)
          .maybeSingle();
        accountName = (acct as { company_name: string } | null)?.company_name ?? null;
      }
      await insertCommercialOppStatusChangedNotifications({
        opportunityId: input.opp_id,
        oppTitle: derivedOppName(updated, accountName),
        fromStatusLabel: opportunityStatusLabel(beforeRow.status),
        toStatusLabel: opportunityStatusLabel(input.to_status),
        actingUserId: input.acting_user_id,
        actorName,
        note: input.note?.trim() || null,
      });
    } catch (err) {
      console.warn(
        "[status] status_changed notify failed:",
        err instanceof Error ? err.message : String(err)
      );
    }
  })();

  return { ok: true, opportunity: updated };
}

/** List status_log rows for a single opp, most-recent first. Drives the
 *  Timeline tab + the "days in current status" badge in later batches. */
export type OpportunityStatusLogRow = {
  id: string;
  opportunity_id: string;
  from_status: OpportunityStatus | null;
  to_status: OpportunityStatus;
  changed_by_user_id: string | null;
  changed_at: string;
  note: string | null;
  loss_reason: OpportunityLossReason | null;
};

/** Bulk: most-recent status-change timestamp per opp (the time the opp
 *  ENTERED its current status). Lets the list page show "5d in
 *  estimating" without N+1. Empty Map if migration 029 hasn't run. */
export async function listCurrentStatusEnteredAtByOpp(
  opportunity_ids: string[]
): Promise<Map<string, string>> {
  if (opportunity_ids.length === 0) return new Map();
  const sb = commercialDb();
  const { data, error } = await sb
    .from("commercial_opportunity_status_log")
    .select("opportunity_id, to_status, changed_at")
    .in("opportunity_id", opportunity_ids)
    .order("changed_at", { ascending: false });
  if (error) {
    console.warn(
      "[commercial/opportunities/status] listCurrentStatusEnteredAtByOpp:",
      error.message
    );
    return new Map();
  }
  // Take the most recent entry per opp — that's when its current
  // status was entered.
  const out = new Map<string, string>();
  for (const r of (data ?? []) as Array<{
    opportunity_id: string;
    changed_at: string;
  }>) {
    if (!out.has(r.opportunity_id)) out.set(r.opportunity_id, r.changed_at);
  }
  return out;
}

export async function listOpportunityStatusLog(
  opportunity_id: string
): Promise<OpportunityStatusLogRow[]> {
  const sb = commercialDb();
  const { data, error } = await sb
    .from("commercial_opportunity_status_log")
    .select("*")
    .eq("opportunity_id", opportunity_id)
    .order("changed_at", { ascending: false });
  if (error) {
    console.warn(
      "[commercial/opportunities/status] listOpportunityStatusLog failed:",
      error.message
    );
    return [];
  }
  return (data ?? []) as OpportunityStatusLogRow[];
}
