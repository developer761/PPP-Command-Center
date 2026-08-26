import "server-only";

import { commercialDb } from "@/lib/commercial/db";
import { logInsert, logUpdate, logDelete } from "@/lib/commercial/audit-log";
import {
  DEFAULT_PROBABILITY_BY_STATUS,
  DEFAULT_PROBABILITY_BY_SUB_STATUS,
  DEFAULT_SUB_STATUS_BY_STATUS,
  isValidSubStatus,
  FULLY_CLOSED_SUB_STATUSES,
} from "./constants";
import { assignDealNumber } from "./db";
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
  /** v2 sub-status (migration 052). If omitted, the DEFAULT_SUB_STATUS_BY_STATUS
   *  fallback for `status` is used (e.g. qualifying → solicitation). */
  sub_status?: string | null;
  /** v2 follow-up scheduling (Katie's ask). */
  follow_up_at?: string | null;
  follow_up_notes?: string | null;
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
  estimator_user_id?: string | null;
  // Migration 049 — free-text estimator name (subs / off-roster).
  estimator_name?: string | null;
  // Migration 069 (Katie 2026-07-20) — RFP arrival date + custom name
  // override. Both nullable; NULL is the default state.
  rfp_received_at?: string | null;
  title_override?: string | null;
  // Migration 122 — a deal can carry its own team (distinct from the GC's).
  team_id?: string | null;
  created_by_user_id?: string | null;
};


/**
 * Where a brand-new opportunity starts.
 *
 * Brendan's ladder is RFP → Estimating, with Estimating "triggering on
 * estimator assign". `updateCommercialOpportunity` honours that (mutations.ts,
 * `gainedEstimator`); create did not, so a deal typed in with an estimator
 * already picked — exactly what the form invites, since Estimator is one of
 * its fields — landed in Qualifying and sat there until somebody drafted a
 * proposal.
 *
 * RE-AUDIT 2026-08-12, second pass: the first attempt keyed on `!status`,
 * reasoning that an explicit stage is a person's decision. It was dead code —
 * BOTH create forms resolve `formData.get("status") ?? "qualifying"` before
 * calling this, so a status is always supplied and the branch never ran.
 *
 * It now mirrors the edit trigger exactly: fire when the deal would land in
 * `qualifying`, which covers Qualifying and RFP (they share a status), and
 * leave anything further along untouched. Someone logging a deal that is
 * already out to the GC picks Sent, and Sent is not qualifying, so the
 * inference stays out of it. Forward-only by construction.
 *
 * Exported so the rule is tested where it lives rather than re-implemented in
 * a test — the first version WAS re-implemented, and the copy asserted the
 * broken behaviour, which is how a green suite hid a dead fix.
 */
export function stageForNewOpportunity(
  requested: OpportunityStatus | null | undefined,
  estimatorUserId: string | null | undefined
): OpportunityStatus {
  const status = (requested ?? "qualifying") as OpportunityStatus;
  if (status === "qualifying" && estimatorUserId) return "estimating" as OpportunityStatus;
  return status;
}

export async function createCommercialOpportunity(
  input: CreateOpportunityInput
): Promise<{ ok: true; opportunity: CommercialOpportunity } | { ok: false; error: string }> {
  if (!input.title?.trim()) return { ok: false, error: "Title is required." };
  if (input.title.length > 200) return { ok: false, error: "Title too long (max 200 chars)." };

  const sb = commercialDb();

  // Which team covers this address? Resolved BEFORE the insert so the deal is
  // created already staffed, rather than saved and then corrected.
  // Best-effort: a territory lookup must never block creating a job.
  let territoryTeamId: string | null = null;
  if (!input.team_id && input.property_zip?.trim()) {
    try {
      const { teamForZip } = await import("@/lib/commercial/teams/db");
      territoryTeamId = (await teamForZip(input.property_zip))?.teamId ?? null;
    } catch {
      territoryTeamId = null;
    }
  }

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

  const status = stageForNewOpportunity(input.status, input.estimator_user_id);
  // v2 (migration 052): sub_status is NOT NULL. Fall back to the default
  // sub-status for the picked status if the caller didn't supply one.
  // If they DID supply one, validate it against the parent-status whitelist.
  const subStatus =
    input.sub_status && isValidSubStatus(status, input.sub_status)
      ? input.sub_status
      : ((DEFAULT_SUB_STATUS_BY_STATUS as Record<string, string>)[status] ??
        "rfp");
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

  // Migration 065 (Phase G Q1): assign per-account sequential deal
  // number ("ALT-0125") BEFORE the insert. Fire-and-forget style —
  // if the counter fails, we still create the opp with deal_number=NULL
  // and let admin repair via re-assignment. Matches Tomco's "No. ALT0125"
  // convention on the JD Sports reference PDF.
  const dealNumber = await assignDealNumber(input.account_id);

  const { data, error } = await sb
    .from("commercial_opportunities")
    .insert({
      account_id: input.account_id,
      primary_contact_id: primaryContactId,
      title: input.title.trim(),
      description: input.description?.trim() || null,
      status,
      sub_status: subStatus,
      follow_up_at: input.follow_up_at ?? null,
      follow_up_notes: input.follow_up_notes?.trim() || null,
      source: input.source ?? null,
      bid_value_low_cents: low,
      bid_value_high_cents: high,
      probability_pct:
        input.probability_pct ??
        DEFAULT_PROBABILITY_BY_SUB_STATUS[subStatus] ??
        DEFAULT_PROBABILITY_BY_STATUS[status] ??
        10,
      proposed_start_at: input.proposed_start_at ?? null,
      proposed_end_at: input.proposed_end_at ?? null,
      proposal_due_at: input.proposal_due_at ?? null,
      property_street: input.property_street?.trim() || null,
      property_city: input.property_city?.trim() || null,
      property_state: input.property_state?.trim() || null,
      property_zip: input.property_zip?.trim() || null,
      client_name: input.client_name?.trim() || null,
      estimator_user_id: input.estimator_user_id ?? null,
      // If the picker chose a user, clear the free-text field (and vice
      // versa). Prevents "old typo lingers after switching to the FK."
      estimator_name: input.estimator_user_id
        ? null
        : input.estimator_name?.trim() || null,
      deal_number: dealNumber,
      // Migration 069 — new nullable fields, insert as-supplied.
      rfp_received_at: input.rfp_received_at ?? null,
      title_override: input.title_override?.trim() || null,
      // Territory default — Brendan 2026-08-25: "the location of the job will
      // determine the team who will execute the project."
      //
      // Only when the caller did NOT pick one. An explicit choice always wins:
      // this is a default, not a rule, and a crew someone deliberately assigned
      // must never be replaced because of an address.
      team_id: input.team_id ?? territoryTeamId,
      created_by_user_id: input.created_by_user_id ?? null,
      updated_by_user_id: input.created_by_user_id ?? null,
    })
    .select("*")
    .single();

  if (error) return { ok: false, error: error.message };
  const opp = data as CommercialOpportunity;
  await logInsert("commercial_opportunities", opp.id, opp, input.created_by_user_id);

  // Staff the job from its team.
  //
  // Setting team_id on the insert names a crew but assigns nobody — this path
  // does not go through setOwnerTeam, which is where the roster is applied. A
  // deal created with a team and an empty Team tab is exactly the "picking a
  // team does nothing" complaint Brendan raised, just arriving by a different
  // route. Best-effort: the job exists either way.
  if (opp.team_id) {
    try {
      const { applyTeamToOpportunityAssignments } = await import("@/lib/commercial/teams/db");
      await applyTeamToOpportunityAssignments(
        opp.id,
        opp.team_id,
        input.created_by_user_id ?? ""
      );
    } catch (err) {
      console.warn("[opportunities] staffing from team failed:", err instanceof Error ? err.message : err);
    }
  }

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
  /** Per-job tax exemption (migration 139). Three-state on purpose:
   *  null = inherit the account, true/false = override for this job. Resolve
   *  reads via lib/commercial/tax/exemption.ts, never by hand. */
  tax_exempt?: boolean | null;
  tax_exempt_cert_number?: string | null;
  tax_exempt_reason?: "certificate" | "capital_improvement" | null;
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
  // v2 (migration 052): status + sub_status live under a tuple CHECK
  // constraint. If a caller flips `status` without also supplying a
  // matching `sub_status`, the stale sub_status from the old status
  // lane will violate the CHECK and the whole UPDATE bounces with
  // "commercial_opportunities_status_check". Default the sub_status to
  // the target lane's entry point (mirrors changeOpportunityStatus and
  // createCommercialOpportunity) so /commercial/opportunities/[id]/edit
  // and any other non-DAG update path doesn't crash.
  //
  // Karan 2026-07-15: this is what was tripping the Kanban Won-card
  // move — the client also went through a code path that patched
  // status alone.
  if (input.status !== undefined) {
    patch.status = input.status;
    const suppliedSub =
      input.sub_status && isValidSubStatus(input.status, input.sub_status)
        ? input.sub_status
        : null;
    patch.sub_status =
      suppliedSub ??
      (DEFAULT_SUB_STATUS_BY_STATUS as Record<string, string>)[input.status] ??
      "rfp";
  } else if (input.sub_status !== undefined) {
    // Sub-status-only flip: caller is nudging within a lane. Only
    // accept if it validates against the CURRENT top-level status
    // (before-row snapshot) so we never write a busted tuple.
    const currentStatus = (before as { status: string }).status;
    if (input.sub_status && isValidSubStatus(currentStatus, input.sub_status)) {
      patch.sub_status = input.sub_status;
    }
  }
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
  // `!== undefined` and not a truthiness check: `false` is a real answer here
  // ("taxable, even though the customer is exempt"), and `null` is a third
  // ("inherit"). Collapsing them would make an exempt customer's taxable job
  // impossible to record.
  if (input.tax_exempt !== undefined) patch.tax_exempt = input.tax_exempt;
  if (input.tax_exempt_reason !== undefined) patch.tax_exempt_reason = input.tax_exempt_reason;
  if (input.tax_exempt_cert_number !== undefined) {
    patch.tax_exempt_cert_number = input.tax_exempt_cert_number?.trim() || null;
  }
  // Migration 046 (Phase B) — CEO structural fields.
  if (input.client_name !== undefined) patch.client_name = input.client_name?.trim() || null;
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
  // Migration 069 (Katie 2026-07-20) — RFP date + custom name. Empty
  // string trims to null so a user can clear either by blanking the
  // input.
  if (input.rfp_received_at !== undefined) {
    patch.rfp_received_at = input.rfp_received_at || null;
  }
  if (input.title_override !== undefined) {
    patch.title_override = input.title_override?.trim() || null;
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

  // Two surfaces now choose the proposal's "Attention" contact: this field on
  // the deal edit sheet, and the per-job contacts card (migration 141), whose
  // is_primary link WINS in hydrateProposalContext. So changing it here was
  // silently overridden on any job that had a flagged contact — the picker
  // still said one name while the PDF printed another.
  //
  // Setting it here is an explicit act, so it takes effect: the job's flag is
  // cleared and the chosen person becomes the Attention contact on both.
  // Last explicit action wins, and the two surfaces agree.
  // ONLY when the value actually CHANGED.
  //
  // The first version of this ran whenever the field was merely present, and
  // the deal edit sheet always posts it — its picker is seeded from
  // `deal.primary_contact_id` alone, so on a job whose Attention was set via
  // the Contacts card the picker sat blank, resolved to null, and every
  // unrelated save (fixing an RFP date) silently cleared the site super's
  // Attention flag. The next proposal then printed no ATTENTION line at all.
  // That is the reverse of the bug the sync was added to fix, and it was worse
  // — it needed no deliberate action to trigger.
  //
  // Comparing against `before` makes an untouched picker a no-op, which is the
  // same guard this action already uses for the proposed start/end dates.
  const priorContactId = (before as { primary_contact_id?: string | null }).primary_contact_id ?? null;
  const nextContactId = input.primary_contact_id ?? null;
  if (input.primary_contact_id !== undefined && nextContactId !== priorContactId) {
    await sb
      .from("commercial_opportunity_contacts")
      .update({ is_primary: false })
      .eq("opportunity_id", opp.id)
      .eq("is_primary", true);
    if (nextContactId) {
      await sb
        .from("commercial_opportunity_contacts")
        .update({ is_primary: true })
        .eq("opportunity_id", opp.id)
        .eq("contact_id", nextContactId);
    }
  }

  // ── Brendan's trigger: assigning an estimator IS moving to Estimating ─────
  //
  // "Then it should be estimating. This should trigger when we assign the
  // estimator." (2026-08-12). Nobody assigns an estimator to a job they aren't
  // about to price, so making someone then ALSO change the stage is asking
  // them to state the same fact twice — and the second statement is the one
  // that gets forgotten, which is how a deal sits in Qualifying with a
  // half-built estimate on it.
  //
  // Only forward, and only from the two stages before it: an estimator swapped
  // on a job already Sent must not drag it backwards.
  const gainedEstimator =
    !before.estimator_user_id && !!opp.estimator_user_id;
  if (gainedEstimator && (opp.status === "qualifying")) {
    try {
      const { changeOpportunityStatus } = await import("./status");
      await changeOpportunityStatus({
        opp_id: opp.id,
        to_status: "estimating",
        to_sub_status: "estimating",
        acting_user_id: input.updated_by_user_id ?? null,
        // The engine did this, not a person — so it must not stamp
        // status_user_set_at and lock the deal against later auto-advances.
        source: "auto_advance",
        _skipDagCheck: true,
      });
    } catch (err) {
      // Best-effort: assigning an estimator must never fail because the stage
      // move did. The next artifact will advance it anyway.
      console.warn("[opportunities] estimator-assigned auto-advance failed:", err);
    }
  }

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

  // Cascade: tombstone this deal's transactions (purchases) too. Masked today
  // — every viewer/aggregator drives off an ACTIVE-opp id list, so dead-deal
  // costs aren't summed — but that's an invariant living in the callers, not
  // the data. The first report that sums commercial_project_purchases directly
  // (all-purchases, or by date range) without joining the parent's deleted_at
  // leaks zombie costs into company P&L, and a wrong number nobody can see the
  // source of is the worst kind. Invoices are already tombstoned; this makes
  // costs consistent with them.
  {
    const now = new Date().toISOString();
    const { data: purchases } = await sb
      .from("commercial_project_purchases")
      .select("id")
      .eq("opportunity_id", id)
      .is("deleted_at", null);
    const purchaseIds = ((purchases ?? []) as { id: string }[]).map((p) => p.id);
    if (purchaseIds.length > 0) {
      await sb
        .from("commercial_project_purchases")
        .update({ deleted_at: now })
        .in("id", purchaseIds);
    }
  }

  // Cascade: tear down this deal's Field Ops work order(s) too — otherwise a
  // deleted deal leaves an orphaned job on the Work Orders / Status / Calendar
  // surfaces (the "Karan / k" stray-WO bug). softDeleteJob cancels future
  // assignments + reopens a sent WO to draft, so crew aren't left scheduled on a
  // dead deal. Dynamic import breaks the opp ↔ field-ops module cycle.
  try {
    const { cascadeDeleteJobsForOwner } = await import("@/lib/commercial/field-ops/jobs");
    await cascadeDeleteJobsForOwner({ opportunity_id: id }, deletedByUserId ?? "system");
  } catch (err) {
    console.warn("[opportunities] field-ops cascade delete failed:", err);
  }

  // Cascade: the PROJECT (migration 131). Caught by the parallel session's audit
  // of the restructure — this list tombstoned the invoices, the costs and the
  // crew schedule but not the record that now carries the CONTRACT VALUE, so a
  // deleted deal left a live project holding money behind it. Invisible only
  // because nothing lists projects yet, which makes it exactly the kind of stale
  // number that corrupts a total the day the project list ships.
  //
  // `ensureProjectForOpportunity` re-reads the deal and mirrors `deleted_at`
  // onto the project, so the same call is correct on delete, restore, archive
  // and unarchive — one routine, no fourth copy of the rule to drift.
  await syncProjectForOpportunity(id);

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
  // Best-effort cascade-restore. Tightened to ±2s (audit fix
  // 2026-07-11) after a lane found the previous 5s window could
  // theoretically resurrect an invoice that was independently deleted
  // right around the same moment. 2s comfortably covers the ~50-100ms
  // between the opp delete and its cascaded invoice delete in the
  // same request, but keeps the collateral-restore blast radius
  // small.
  //
  // Perfect fix would tag cascaded invoices with a batch id at
  // delete time — that's a schema change for a future migration.
  const cascadeWindowStart = new Date(deletedAt - 2000).toISOString();
  const cascadeWindowEnd = new Date(deletedAt + 2000).toISOString();

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

  // …and the transactions tombstoned in the same batch.
  await sb
    .from("commercial_project_purchases")
    .update({ deleted_at: null })
    .eq("opportunity_id", id)
    .gte("deleted_at", cascadeWindowStart)
    .lte("deleted_at", cascadeWindowEnd);

  // …and the Field Ops work orders + the crew shifts the teardown cancelled.
  // Without this the undo was asymmetric: the deal and its invoices came back
  // but the work order stayed deleted and the crew stayed unscheduled, so Alex
  // clicked Undo, saw the deal return, and reasonably assumed the crew was
  // back on the calendar.
  try {
    const { cascadeRestoreJobsForOwner } = await import("@/lib/commercial/field-ops/jobs");
    await cascadeRestoreJobsForOwner(
      { opportunity_id: id },
      beforeRow.deleted_at,
      restoredByUserId ?? "system"
    );
  } catch (err) {
    console.warn("[opportunities] field-ops cascade restore failed:", err);
  }

  // …and un-tombstone the project, so Undo is symmetric with the delete above.
  await syncProjectForOpportunity(id);

  await logUpdate("commercial_opportunities", id, before, after, restoredByUserId);
  return { ok: true };
}

/**
 * Make the deal's project row match the deal again.
 *
 * Delete, restore, archive and unarchive all change a flag the project mirrors,
 * and all four used to leave it untouched. `ensureProjectForOpportunity` re-reads
 * the deal and reconciles, so one call is right on every path — the alternative
 * was four copies of the mirroring rule, which is how they drift.
 *
 * Best-effort: a deal must never fail to delete because its project row
 * wouldn't update. Dynamic import keeps the module cycle broken.
 */
async function syncProjectForOpportunity(id: string): Promise<void> {
  try {
    const { ensureProjectForOpportunity } = await import("@/lib/commercial/projects/ensure");
    const res = await ensureProjectForOpportunity(id);
    if (!res.ok) console.warn("[opportunities] project sync failed:", res.error);
  } catch (err) {
    console.warn("[opportunities] project sync threw:", err);
  }
}

/**
 * Write ONE allowlisted column on an opportunity, from the inline editor.
 *
 * The caller validates the field against `INLINE_FIELDS` before reaching here;
 * this is the second lock on the same door, because a writer that trusts its
 * caller is one refactor away from writing anything.
 *
 * Audited like every other mutation — an edit that leaves no trace is how a
 * number changes and nobody can say when or who.
 */
export async function updateOpportunityField(
  id: string,
  field: string,
  value: string | number | null,
  actorUserId: string | null
): Promise<{ ok: true } | { ok: false; error: string }> {
  const { INLINE_FIELDS } = await import("./inline-fields");
  if (!INLINE_FIELDS.some((f) => f.name === field)) {
    return { ok: false, error: "That field can't be edited here." };
  }
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
    .update({ [field]: value, updated_by_user_id: actorUserId })
    .eq("id", id)
    .is("deleted_at", null)
    .select("*")
    .maybeSingle();
  if (error) return { ok: false, error: error.message };
  if (!after) return { ok: false, error: "Opportunity not found." };

  await logUpdate("commercial_opportunities", id, before, after, actorUserId);
  return { ok: true };
}
