import "server-only";

import { commercialDb } from "@/lib/commercial/db";
import { logUpdate, logInsert } from "@/lib/commercial/audit-log";
import { insertCommercialOppStatusChangedNotifications } from "@/lib/notifications/commercial-events";
import {
  ALLOWED_TRANSITIONS,
  DEFAULT_PROBABILITY_BY_STATUS,
  DEFAULT_PROBABILITY_BY_SUB_STATUS,
  DEFAULT_SUB_STATUS_BY_STATUS,
  PROBABILITY_PRESERVING_STATUSES,
  PROBABILITY_PRESERVING_SUB_STATUSES,
  TERMINAL_STATUSES,
  WARN_TRANSITIONS,
  isValidSubStatus,
  isLost,
} from "./constants";
import {
  type CommercialOpportunity,
  type OpportunityStatus,
  type OpportunityLossReason,
  OPPORTUNITY_LOSS_REASONS,
  opportunityStatusLabel,
  derivedOppName,
} from "./db";

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
};

export async function changeOpportunityStatus(
  input: ChangeStatusInput
): Promise<
  | { ok: true; opportunity: CommercialOpportunity }
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

  // No-op if already at the target status. Friendly success — caller
  // doesn't need to handle this as an error.
  if (beforeRow.status === input.to_status) {
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

  // Karan 2026-07-15: removed the DAG check, the "Won with live
  // invoices" guard, and the "leaving Qualifying needs structural
  // fields" guard entirely. Every one of these was blocking the
  // kanban's "let me move deals anywhere" freedom Karan asked for,
  // AND it was silently failing the proposal→opp cascade (when a
  // Sent proposal was flipped to Won, changeOpportunityStatus bailed
  // because the parent opp was still at Qualifying with no structural
  // fields, so the opp stayed put while the proposal moved to Won).
  //
  // App-layer safety left in place:
  //   - Lost still requires a loss_reason + note (below) — that's
  //     input validation, not a movement block; the debrief page
  //     collects the fields before submitting.
  //   - Structural fields are still enforced ONLY on the debrief flow
  //     (client_name required for won deals to generate proposals /
  //     invoices), not on the mere status flip.
  //
  // DB CHECK constraints were dropped in migration 059 for the same
  // "no constraints whatsoever" reason. This is the app-layer twin.
  const targetIsLost =
    input.to_status === "pre_sale_closed" && input.to_sub_status === "lost";

  // Loss-reason enforcement when the closure is a Lost.
  // v2 (migration 052): "Lost" is Pre-Sale/Closed/Lost — i.e. status =
  // pre_sale_closed AND sub_status = lost.
  let lossReason: OpportunityLossReason | null = null;
  let lossNote: string | null = null;
  if (targetIsLost) {
    if (!input.loss_reason || !OPPORTUNITY_LOSS_REASONS.includes(input.loss_reason)) {
      return {
        ok: false,
        error: "Pick a reason for losing (or `no_bid` if we declined to bid).",
      };
    }
    if (!input.note || !input.note.trim()) {
      return {
        ok: false,
        error: "Add a short note explaining the loss.",
      };
    }
    lossReason = input.loss_reason;
    lossNote = input.note.trim();
  }

  // Decide probability_pct for the patch:
  // - If the user overrode the prior status's default (current pct
  //   isn't equal to the default for the from status), KEEP the
  //   override — they meant it.
  // - If transitioning INTO a probability-preserving status
  //   (follow_up in v1.1), keep the current value regardless — waiting
  //   on the customer doesn't change how likely you are to win.
  // - Otherwise auto-set to the new status's default.
  const fromDefault = DEFAULT_PROBABILITY_BY_STATUS[beforeRow.status] ?? null;
  const userOverrode = fromDefault !== null && beforeRow.probability_pct !== fromDefault;
  const preserveProbability = PROBABILITY_PRESERVING_STATUSES.has(input.to_status);
  const nextProbability =
    userOverrode || preserveProbability
      ? beforeRow.probability_pct
      : DEFAULT_PROBABILITY_BY_STATUS[input.to_status] ?? beforeRow.probability_pct;

  // decided_at auto-management: set today when entering a terminal
  // state (won/lost/no_bid); CLEAR when leaving one (e.g. reopened).
  const wasTerminal = TERMINAL_STATUSES.has(beforeRow.status);
  const isTerminal = TERMINAL_STATUSES.has(input.to_status);
  let nextDecidedAt: string | null | undefined = undefined; // undefined = don't touch
  if (isTerminal && !wasTerminal) {
    nextDecidedAt = new Date().toISOString().slice(0, 10); // DATE column
  } else if (!isTerminal && wasTerminal) {
    nextDecidedAt = null;
  }

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
        "solicitation");
  const patch: Record<string, unknown> = {
    status: input.to_status,
    sub_status: nextSubStatus,
    probability_pct: nextProbability,
    updated_by_user_id: input.acting_user_id ?? null,
  };
  if (nextDecidedAt !== undefined) patch.decided_at = nextDecidedAt;
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

  const { data: after, error: updateErr } = await sb
    .from("commercial_opportunities")
    .update(patch)
    .eq("id", input.opp_id)
    .select("*")
    .single();
  if (updateErr) return { ok: false, error: updateErr.message };
  const updated = after as CommercialOpportunity;

  // Append the status_log row. Failure here doesn't undo the opp
  // update — last-write-wins on the opp row is fine, but the log gap
  // is worth knowing about. Audit-log captures the opp change anyway.
  const { data: logRow, error: logErr } = await sb
    .from("commercial_opportunity_status_log")
    .insert({
      opportunity_id: input.opp_id,
      from_status: beforeRow.status,
      to_status: input.to_status,
      changed_by_user_id: input.acting_user_id ?? null,
      note: input.note?.trim() || null,
      loss_reason: lossReason,
    })
    .select("*")
    .single();
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

  // Audit the opp update with the full before/after snapshot.
  await logUpdate(
    "commercial_opportunities",
    input.opp_id,
    beforeRow,
    updated,
    input.acting_user_id
  );

  // Karan 2026-07-15: cascade opp → child proposals. If the deal just
  // closed as Won/Lost, flip its Sent proposal(s) to the matching
  // outcome so the /commercial/proposals kanban and every proposal
  // surface reflects reality without the user having to remember to
  // move both sides. Mirrors markProposalOutcome (which cascades the
  // OTHER direction: proposal → opp).
  //
  // Reverse cascade: if the deal moved OUT of pre_sale_closed (undo),
  // flip any Won/Lost proposals back to Sent so we don't strand them
  // in a terminal state.
  //
  // Scope: only touches `sent` proposals on the Won/Lost cascade
  // (drafts + pending-approval are "attempts along the way", never
  // "the winning proposal") and only `won`/`lost` on the reverse
  // (expired/replaced are intentional terminal states, not undo-able
  // via opp movement). SYNCHRONOUS (awaited) — the caller typically
  // router.refresh()es right after this returns, and we need the
  // proposal-side flip visible in that first refresh. Best-effort:
  // a failure here logs a warning but never rolls back the opp update.
  try {
    const enteredPreSaleClosed =
      input.to_status === "pre_sale_closed" &&
      beforeRow.status !== "pre_sale_closed";
    const leftPreSaleClosed =
      beforeRow.status === "pre_sale_closed" &&
      input.to_status !== "pre_sale_closed";
    if (enteredPreSaleClosed || leftPreSaleClosed) {
      const { updateProposalStatus } = await import(
        "@/lib/commercial/proposals/db"
      );
      const targetStatuses = enteredPreSaleClosed ? ["sent"] : ["won", "lost"];
      const nextStatus = enteredPreSaleClosed
        ? input.to_sub_status === "won"
          ? "won"
          : "lost"
        : "sent";
      const { data: propRows } = await sb
        .from("commercial_proposals")
        .select("id, status")
        .eq("opportunity_id", input.opp_id)
        .is("deleted_at", null)
        .in("status", targetStatuses);
      const proposals =
        (propRows as { id: string; status: string }[] | null) ?? [];
      for (const p of proposals) {
        if (p.status === nextStatus) continue;
        const flip = await updateProposalStatus({
          id: p.id,
          to_status: nextStatus,
          acting_user_id: input.acting_user_id,
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

  // Fan out a bell + email to every active team member on the opp
  // (minus the actor). Fire-and-forget — never blocks the status flip.
  // Helper handles the self-skip + inactive-skip + fanout query.
  void (async () => {
    try {
      let actorName = "PPP admin";
      if (input.acting_user_id) {
        const { data: actor } = await sb
          .from("profiles")
          .select("sf_user_name, email")
          .eq("user_id", input.acting_user_id)
          .maybeSingle();
        const a = actor as { sf_user_name?: string | null; email?: string | null } | null;
        actorName = a?.sf_user_name || a?.email || "PPP admin";
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
