import "server-only";

import { commercialDb } from "@/lib/commercial/db";
import { logUpdate, logInsert } from "@/lib/commercial/audit-log";
import { insertCommercialOppStatusChangedNotifications } from "@/lib/notifications/commercial-events";
import {
  ALLOWED_TRANSITIONS,
  DEFAULT_PROBABILITY_BY_STATUS,
  PROBABILITY_PRESERVING_STATUSES,
  TERMINAL_STATUSES,
  WARN_TRANSITIONS,
} from "./constants";
import {
  type CommercialOpportunity,
  type OpportunityStatus,
  type OpportunityLossReason,
  OPPORTUNITY_LOSS_REASONS,
  opportunityStatusLabel,
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
  acting_user_id: string | null;
  /** Free-form note. Required (non-empty) when to_status='lost'. */
  note?: string | null;
  /** Required (non-null) when to_status='lost'. */
  loss_reason?: OpportunityLossReason | null;
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

  // DAG check.
  if (!isTransitionAllowed(beforeRow.status, input.to_status)) {
    return {
      ok: false,
      error: `Can't go from ${beforeRow.status} → ${input.to_status}.`,
    };
  }

  // Karan 2026-07-08: block reversing a Won deal that already has live
  // invoices attached. Won → reopened → lost is a legal DAG path, but if
  // an invoice was issued (or worse — paid) the financial story on the
  // account depends on this deal being Won. Force the user to void the
  // invoices first so the money side and the pipeline side stay in sync.
  if (beforeRow.status === "won" && input.to_status !== "won") {
    // Karan 2026-07-08 refinement: only customer-visible invoices block
    // the reversal. Drafts haven't been sent — safe to un-win a deal
    // that only has drafts attached (drafts can be manually cleaned up
    // or simply left on the (now-Lost) deal for audit history). Sent /
    // viewed / partial / paid all mean the customer knows about the
    // invoice, so reversing Won without voiding those first would be
    // a data-integrity break.
    const { data: liveInvoices } = await sb
      .from("commercial_invoices")
      .select("id, status")
      .eq("opportunity_id", input.opp_id)
      .is("deleted_at", null)
      .in("status", ["sent", "viewed", "partial", "paid"]);
    const blocking = (liveInvoices ?? []) as { id: string; status: string }[];
    if (blocking.length > 0) {
      return {
        ok: false,
        error: `Can't move this off Won — ${blocking.length} customer-visible invoice${blocking.length === 1 ? "" : "s"} still on the deal. Void those first.`,
      };
    }
  }

  // Loss-reason enforcement when transitioning TO a closed-without-win
  // state. Both `lost` and `no_bid` are terminal exits where Alex needs
  // to record WHY — for pipeline analysis (which reasons recur) and
  // CYA against future "you should've gone after this one" questions.
  // Reason enum is shared (price/scope/timing/etc.); semantics differ
  // only in label.
  let lossReason: OpportunityLossReason | null = null;
  let lossNote: string | null = null;
  if (input.to_status === "lost" || input.to_status === "no_bid") {
    if (!input.loss_reason || !OPPORTUNITY_LOSS_REASONS.includes(input.loss_reason)) {
      return {
        ok: false,
        error: input.to_status === "no_bid"
          ? "Pick a reason for declining to bid."
          : "Pick a loss reason to mark this lost.",
      };
    }
    if (!input.note || !input.note.trim()) {
      return {
        ok: false,
        error: input.to_status === "no_bid"
          ? "Add a short note explaining why we passed on this."
          : "Add a short note explaining why this was lost.",
      };
    }
    lossReason = input.loss_reason;
    lossNote = input.note.trim();
  }

  // Decide probability_pct for the patch:
  // - If the user overrode the prior status's default (current pct
  //   isn't equal to the default for the from status), KEEP the
  //   override — they meant it.
  // - If transitioning INTO on_hold (probability-preserving), keep
  //   the current value regardless.
  // - Otherwise auto-set to the new status's default.
  const fromDefault = DEFAULT_PROBABILITY_BY_STATUS[beforeRow.status] ?? null;
  const userOverrode = fromDefault !== null && beforeRow.probability_pct !== fromDefault;
  const preserveOnHold = PROBABILITY_PRESERVING_STATUSES.has(input.to_status);
  const nextProbability =
    userOverrode || preserveOnHold
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
  const patch: Record<string, unknown> = {
    status: input.to_status,
    probability_pct: nextProbability,
    updated_by_user_id: input.acting_user_id ?? null,
  };
  if (nextDecidedAt !== undefined) patch.decided_at = nextDecidedAt;
  if (input.to_status === "lost" || input.to_status === "no_bid") {
    patch.loss_reason = lossReason;
    patch.loss_notes = lossNote;
  } else if (beforeRow.status === "lost" || beforeRow.status === "no_bid") {
    patch.loss_reason = null;
    patch.loss_notes = null;
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
      await insertCommercialOppStatusChangedNotifications({
        opportunityId: input.opp_id,
        oppTitle: updated.title,
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
