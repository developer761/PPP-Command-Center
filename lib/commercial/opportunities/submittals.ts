import "server-only";

import { commercialDb } from "@/lib/commercial/db";
import { logDelete, logInsert, logUpdate, writeCommercialAudit } from "@/lib/commercial/audit-log";
import {
  ALLOWED_SUBMITTAL_TRANSITIONS,
  INCLUDED_KINDS,
  isTerminalSubmittalStatus,
  SUBMITTAL_RESPONSES,
  SUBMITTAL_STATUSES,
  TRANSMITTED_AS_OPTIONS,
  type IncludedKind,
  type SubmittalResponse,
  type SubmittalStatus,
  type TransmittedAs,
} from "./submittal-constants";

/**
 * Submittals — Letter of Transmittal records per opportunity.
 *
 * Real-world reference: a Tomco Painting → Alta Construction submittal
 * package PDF. See ~/Desktop/SUBMITTALS_PHASE_PLAN.md for the workflow +
 * audit findings baked into this lib.
 *
 * Schema: commercial_opp_submittals + commercial_opp_submittal_items +
 * commercial_opp_submittal_status_log (migration 041).
 *
 * Patterns matched from existing libs:
 *   - "server-only" first
 *   - commercialDb() singleton
 *   - Discriminated result types on every mutation
 *   - Chain-of-trust scoping (opp + account deleted_at guards)
 *   - Double-scope on lookup before mutate (eq id + eq opportunity_id)
 *   - Status mutation only through changeSubmittalStatus (mirror status.ts)
 *   - No child deleted_at — hide via parent opp.deleted_at (audit C5)
 *   - Race-guard on conditional updates via WHERE precondition (audit C1)
 *   - Audit log via logInsert/Update/Delete after success
 */

// ─── Types ───────────────────────────────────────────────────────────

export type OpportunitySubmittal = {
  id: string;
  opportunity_id: string;
  submittal_number: number;
  revises_submittal_id: string | null;
  revision_number: number;
  status: SubmittalStatus;
  to_company: string | null;
  to_attention: string | null;
  to_address_lines: string[] | null;
  re_subject: string | null;
  included_kinds: IncludedKind[];
  transmitted_as: TransmittedAs | null;
  response: SubmittalResponse | null;
  response_copies: number | null;
  sent_at: string | null;
  response_received_at: string | null;
  remarks: string | null;
  voided_at: string | null;
  voided_by_user_id: string | null;
  void_reason: string | null;
  created_at: string;
  created_by_user_id: string | null;
  updated_at: string;
  updated_by_user_id: string | null;
};

export type OpportunitySubmittalWithItemCount = OpportunitySubmittal & {
  item_count: number;
};

export type SubmittalStatusLogRow = {
  id: string;
  submittal_id: string;
  from_status: string | null;
  to_status: string;
  changed_at: string;
  changed_by_user_id: string | null;
  note: string | null;
};

// ─── List ────────────────────────────────────────────────────────────

/**
 * List all submittals for an opp, newest first. Returns [] when:
 *   - opp doesn't exist
 *   - opp.deleted_at IS NOT NULL
 *   - parent account is soft-deleted
 * Adds an `item_count` derived from a separate bulk query so the list page
 * doesn't N+1 to fetch items per row.
 */
export async function listOpportunitySubmittals(
  opportunity_id: string
): Promise<OpportunitySubmittalWithItemCount[]> {
  const sb = commercialDb();

  // Chain-of-trust guard (audit C5 + 2026-06-24 fix shape).
  const { data: opp } = await sb
    .from("commercial_opportunities")
    .select("id, account_id, deleted_at")
    .eq("id", opportunity_id)
    .maybeSingle();
  if (!opp) return [];
  const oppRow = opp as { id: string; account_id: string; deleted_at: string | null };
  if (oppRow.deleted_at) return [];

  const { data: acct } = await sb
    .from("commercial_accounts")
    .select("id, deleted_at")
    .eq("id", oppRow.account_id)
    .maybeSingle();
  if (!acct || (acct as { deleted_at: string | null }).deleted_at) return [];

  const { data, error } = await sb
    .from("commercial_opp_submittals")
    .select("*")
    .eq("opportunity_id", opportunity_id)
    .order("created_at", { ascending: false });
  if (error) {
    console.warn("[commercial/opportunities/submittals] list failed:", error.message);
    return [];
  }
  const submittals = (data ?? []) as OpportunitySubmittal[];
  if (submittals.length === 0) return [];

  // Bulk item count — single query keyed by submittal_id.
  const ids = submittals.map((s) => s.id);
  const { data: itemRows } = await sb
    .from("commercial_opp_submittal_items")
    .select("submittal_id")
    .in("submittal_id", ids);
  const countBy = new Map<string, number>();
  for (const r of (itemRows ?? []) as { submittal_id: string }[]) {
    countBy.set(r.submittal_id, (countBy.get(r.submittal_id) ?? 0) + 1);
  }
  return submittals.map((s) => ({ ...s, item_count: countBy.get(s.id) ?? 0 }));
}

/**
 * Bulk submittal-count by opp_id — fuels the opp list badge ("📋 2 sub").
 * Does NOT chain-of-trust because the caller already filtered out deleted opps.
 */
export async function listSubmittalCountByOpp(
  opportunity_ids: string[]
): Promise<Map<string, { total: number; awaiting_response: number }>> {
  const out = new Map<string, { total: number; awaiting_response: number }>();
  if (opportunity_ids.length === 0) return out;
  const sb = commercialDb();
  const { data, error } = await sb
    .from("commercial_opp_submittals")
    .select("opportunity_id, status")
    .in("opportunity_id", opportunity_ids);
  if (error) {
    console.warn("[commercial/opportunities/submittals] count failed:", error.message);
    return out;
  }
  // "Awaiting response" = sent state, GC hasn't replied yet.
  const AWAITING = new Set<string>(["submitted", "under_review"]);
  for (const row of (data ?? []) as { opportunity_id: string; status: string }[]) {
    const slot = out.get(row.opportunity_id) ?? { total: 0, awaiting_response: 0 };
    slot.total += 1;
    if (AWAITING.has(row.status)) slot.awaiting_response += 1;
    out.set(row.opportunity_id, slot);
  }
  return out;
}

/**
 * Load a single submittal with its items + status log. Double-scoped on
 * opportunity_id so cross-opp hand-crafted POSTs can't read another opp's
 * submittal.
 */
export async function getOpportunitySubmittal(
  opportunity_id: string,
  submittal_id: string
): Promise<{
  submittal: OpportunitySubmittal;
  items: Array<{
    id: string;
    submittal_id: string;
    position: number;
    copies: number;
    item_date: string | null;
    item_number: string | null;
    description: string;
    finish_code: string | null;
    created_at: string;
    updated_at: string;
  }>;
  statusLog: SubmittalStatusLogRow[];
} | null> {
  const sb = commercialDb();

  // Chain-of-trust.
  const { data: opp } = await sb
    .from("commercial_opportunities")
    .select("id, account_id, deleted_at")
    .eq("id", opportunity_id)
    .maybeSingle();
  if (!opp) return null;
  const oppRow = opp as { id: string; account_id: string; deleted_at: string | null };
  if (oppRow.deleted_at) return null;

  const { data: acct } = await sb
    .from("commercial_accounts")
    .select("id, deleted_at")
    .eq("id", oppRow.account_id)
    .maybeSingle();
  if (!acct || (acct as { deleted_at: string | null }).deleted_at) return null;

  // Submittal — double-scoped lookup.
  const { data: subm } = await sb
    .from("commercial_opp_submittals")
    .select("*")
    .eq("id", submittal_id)
    .eq("opportunity_id", opportunity_id)
    .maybeSingle();
  if (!subm) return null;
  const submittal = subm as OpportunitySubmittal;

  // Items + status log in parallel.
  const [{ data: itemRows }, { data: logRows }] = await Promise.all([
    sb
      .from("commercial_opp_submittal_items")
      .select("*")
      .eq("submittal_id", submittal_id)
      .order("position", { ascending: true }),
    sb
      .from("commercial_opp_submittal_status_log")
      .select("*")
      .eq("submittal_id", submittal_id)
      .order("changed_at", { ascending: false }),
  ]);

  return {
    submittal,
    items: (itemRows ?? []) as Array<{
      id: string;
      submittal_id: string;
      position: number;
      copies: number;
      item_date: string | null;
      item_number: string | null;
      description: string;
      finish_code: string | null;
      created_at: string;
      updated_at: string;
    }>,
    statusLog: (logRows ?? []) as SubmittalStatusLogRow[],
  };
}

// ─── Create ──────────────────────────────────────────────────────────

export type CreateOpportunitySubmittalInput = {
  opportunity_id: string;
  to_company?: string | null;
  to_attention?: string | null;
  to_address_lines?: string[] | null;
  re_subject?: string | null;
  included_kinds?: IncludedKind[];
  transmitted_as?: TransmittedAs | null;
  remarks?: string | null;
  revises_submittal_id?: string | null;   // for resubmissions
  created_by_user_id?: string | null;
};

/**
 * Create a new draft submittal. Computes per-opp submittal_number via
 * SELECT MAX + retry on 23505 (audit C1 — race-tolerant).
 *
 * If revises_submittal_id is set, this row is a revision of the parent:
 *   - revision_number = parent.revision_number + 1
 *   - submittal_number = parent.submittal_number (keeps the package ID)
 *   - cover-page fields default from parent (caller can override)
 */
export async function createOpportunitySubmittal(
  input: CreateOpportunitySubmittalInput
): Promise<{ ok: true; submittal: OpportunitySubmittal } | { ok: false; error: string }> {
  const sb = commercialDb();

  // Chain-of-trust.
  const { data: opp } = await sb
    .from("commercial_opportunities")
    .select("id, account_id, deleted_at")
    .eq("id", input.opportunity_id)
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

  // Validate included_kinds payload (defense in depth — DB CHECK also enforces).
  const kinds = input.included_kinds ?? [];
  for (const k of kinds) {
    if (!INCLUDED_KINDS.includes(k)) return { ok: false, error: `Unknown included kind: ${k}` };
  }
  if (input.transmitted_as && !TRANSMITTED_AS_OPTIONS.includes(input.transmitted_as)) {
    return { ok: false, error: `Unknown transmitted_as: ${input.transmitted_as}` };
  }

  // Resolve revision metadata if this is a resubmission.
  let parentSubmittalNumber: number | null = null;
  let parentRevisionNumber: number | null = null;
  let parentSnapshot: Partial<OpportunitySubmittal> = {};
  if (input.revises_submittal_id) {
    const { data: parent } = await sb
      .from("commercial_opp_submittals")
      .select("*")
      .eq("id", input.revises_submittal_id)
      .eq("opportunity_id", input.opportunity_id)
      .maybeSingle();
    if (!parent) return { ok: false, error: "Parent submittal not found." };
    const p = parent as OpportunitySubmittal;
    parentSubmittalNumber = p.submittal_number;
    parentRevisionNumber = p.revision_number;
    // Default the new revision's cover from the parent so Alex doesn't
    // re-type the To/Attention/Subject fields.
    parentSnapshot = {
      to_company: p.to_company,
      to_attention: p.to_attention,
      to_address_lines: p.to_address_lines,
      re_subject: p.re_subject,
      included_kinds: p.included_kinds,
      transmitted_as: p.transmitted_as,
    };
  }

  // Race-tolerant submittal_number assignment (audit C1).
  // Up to 3 attempts; each computes MAX+1 fresh after a 23505 collision.
  for (let attempt = 0; attempt < 3; attempt += 1) {
    let submittal_number: number;
    if (parentSubmittalNumber !== null) {
      submittal_number = parentSubmittalNumber; // keep package ID on revision
    } else {
      const { data: maxRow } = await sb
        .from("commercial_opp_submittals")
        .select("submittal_number")
        .eq("opportunity_id", input.opportunity_id)
        .order("submittal_number", { ascending: false })
        .limit(1)
        .maybeSingle();
      submittal_number = ((maxRow as { submittal_number: number } | null)?.submittal_number ?? 0) + 1;
    }
    const revision_number = parentRevisionNumber !== null ? parentRevisionNumber + 1 : 0;

    const { data: inserted, error: insertErr } = await sb
      .from("commercial_opp_submittals")
      .insert({
        opportunity_id: input.opportunity_id,
        submittal_number,
        revises_submittal_id: input.revises_submittal_id ?? null,
        revision_number,
        status: "draft",
        to_company: input.to_company ?? parentSnapshot.to_company ?? null,
        to_attention: input.to_attention ?? parentSnapshot.to_attention ?? null,
        to_address_lines: input.to_address_lines ?? parentSnapshot.to_address_lines ?? null,
        re_subject: input.re_subject ?? parentSnapshot.re_subject ?? "Submittals",
        included_kinds: kinds.length > 0 ? kinds : (parentSnapshot.included_kinds ?? []),
        transmitted_as: input.transmitted_as ?? parentSnapshot.transmitted_as ?? null,
        remarks: input.remarks ?? null,
        created_by_user_id: input.created_by_user_id ?? null,
        updated_by_user_id: input.created_by_user_id ?? null,
      })
      .select("*")
      .single();

    if (insertErr) {
      // 23505 on (opportunity_id, submittal_number) — concurrent race.
      // Retry with a fresh MAX. Skip retry for revisions because their
      // submittal_number is intentionally not unique within the package.
      if ((insertErr as { code?: string }).code === "23505" && parentSubmittalNumber === null) {
        continue;
      }
      return { ok: false, error: insertErr.message };
    }
    const row = inserted as OpportunitySubmittal;

    // Status log: initial "→ draft" entry.
    await sb.from("commercial_opp_submittal_status_log").insert({
      submittal_id: row.id,
      from_status: null,
      to_status: "draft",
      changed_by_user_id: input.created_by_user_id ?? null,
      note: input.revises_submittal_id ? "Revision of parent submittal" : null,
    });

    await logInsert("commercial_opp_submittals", row.id, row, input.created_by_user_id ?? null);
    return { ok: true, submittal: row };
  }

  return { ok: false, error: "Could not assign a submittal number after retries. Try again." };
}

// ─── Edit (draft only) ───────────────────────────────────────────────

export type EditOpportunitySubmittalInput = {
  opportunity_id: string;
  submittal_id: string;
  to_company?: string | null;
  to_attention?: string | null;
  to_address_lines?: string[] | null;
  re_subject?: string | null;
  included_kinds?: IncludedKind[];
  transmitted_as?: TransmittedAs | null;
  remarks?: string | null;
  updated_by_user_id?: string | null;
};

/**
 * Edit a submittal's cover fields. Only allowed when status === 'draft'.
 * Once submitted/sent, edits are blocked (would invalidate the GC's copy).
 * Terminal/voided submittals are also locked.
 */
export async function editOpportunitySubmittal(
  input: EditOpportunitySubmittalInput
): Promise<{ ok: true; submittal: OpportunitySubmittal } | { ok: false; error: string }> {
  const sb = commercialDb();

  const { data: before } = await sb
    .from("commercial_opp_submittals")
    .select("*")
    .eq("id", input.submittal_id)
    .eq("opportunity_id", input.opportunity_id)
    .maybeSingle();
  if (!before) return { ok: false, error: "Submittal not found." };
  const beforeRow = before as OpportunitySubmittal;
  if (beforeRow.status !== "draft") {
    return {
      ok: false,
      error: `Submittal is ${beforeRow.status} — only drafts can be edited. Create a revision instead.`,
    };
  }

  const patch: Record<string, unknown> = { updated_by_user_id: input.updated_by_user_id ?? null };
  if (input.to_company !== undefined) patch.to_company = input.to_company;
  if (input.to_attention !== undefined) patch.to_attention = input.to_attention;
  if (input.to_address_lines !== undefined) patch.to_address_lines = input.to_address_lines;
  if (input.re_subject !== undefined) patch.re_subject = input.re_subject;
  if (input.included_kinds !== undefined) {
    for (const k of input.included_kinds) {
      if (!INCLUDED_KINDS.includes(k)) return { ok: false, error: `Unknown included kind: ${k}` };
    }
    patch.included_kinds = input.included_kinds;
  }
  if (input.transmitted_as !== undefined) {
    if (input.transmitted_as && !TRANSMITTED_AS_OPTIONS.includes(input.transmitted_as)) {
      return { ok: false, error: `Unknown transmitted_as: ${input.transmitted_as}` };
    }
    patch.transmitted_as = input.transmitted_as;
  }
  if (input.remarks !== undefined) patch.remarks = input.remarks;

  // Race-guard: re-assert status='draft' in WHERE so a concurrent "Send"
  // can't slip through and produce a mid-flight edit (audit S2 pattern).
  const { data: after, error: updErr } = await sb
    .from("commercial_opp_submittals")
    .update(patch)
    .eq("id", input.submittal_id)
    .eq("opportunity_id", input.opportunity_id)
    .eq("status", "draft")
    .select("*")
    .maybeSingle();
  if (updErr) return { ok: false, error: updErr.message };
  if (!after) return { ok: false, error: "Submittal was sent or voided in another tab. Reload to see the latest." };

  await logUpdate(
    "commercial_opp_submittals",
    input.submittal_id,
    before,
    after,
    input.updated_by_user_id ?? null
  );
  return { ok: true, submittal: after as OpportunitySubmittal };
}

// ─── Status DAG ──────────────────────────────────────────────────────

export type ChangeSubmittalStatusInput = {
  opportunity_id: string;
  submittal_id: string;
  to_status: SubmittalStatus;
  changed_by_user_id?: string | null;
  note?: string | null;
  /** For 'submitted' transition: stamps sent_at. Override if recording retroactively. */
  sent_at?: string;
  /** For response-receiving transitions: stamps response_received_at + response/copies. */
  response?: SubmittalResponse;
  response_copies?: number;
  response_received_at?: string;
  /** Required when transitioning to 'voided'. */
  void_reason?: string;
};

/**
 * SINGLE entry point for mutating submittal status. Mirror of
 * lib/commercial/opportunities/status.ts:67 pattern. UI must NEVER write
 * `status` directly via the edit path.
 *
 * Enforces the DAG in submittal-constants.ts. Stamps the right side-effect
 * timestamps (sent_at / response_received_at / voided_at) atomically with
 * the status change.
 */
export async function changeSubmittalStatus(
  input: ChangeSubmittalStatusInput
): Promise<{ ok: true; submittal: OpportunitySubmittal } | { ok: false; error: string }> {
  const sb = commercialDb();

  if (!SUBMITTAL_STATUSES.includes(input.to_status)) {
    return { ok: false, error: `Unknown status: ${input.to_status}` };
  }

  const { data: before } = await sb
    .from("commercial_opp_submittals")
    .select("*")
    .eq("id", input.submittal_id)
    .eq("opportunity_id", input.opportunity_id)
    .maybeSingle();
  if (!before) return { ok: false, error: "Submittal not found." };
  const beforeRow = before as OpportunitySubmittal;

  const fromStatus = beforeRow.status;
  const allowed = ALLOWED_SUBMITTAL_TRANSITIONS[fromStatus] ?? [];
  if (!allowed.includes(input.to_status)) {
    return {
      ok: false,
      error: `Cannot change status from "${fromStatus}" to "${input.to_status}". Allowed: ${allowed.join(", ") || "(none)"}.`,
    };
  }

  // Build the update payload with the right side-effects per target status.
  const patch: Record<string, unknown> = {
    status: input.to_status,
    updated_by_user_id: input.changed_by_user_id ?? null,
  };
  const now = new Date().toISOString();

  if (input.to_status === "submitted") {
    patch.sent_at = input.sent_at ?? now;
  }
  if (
    input.to_status === "approved" ||
    input.to_status === "approved_as_noted" ||
    input.to_status === "revise_and_resubmit" ||
    input.to_status === "rejected"
  ) {
    patch.response_received_at = input.response_received_at ?? now;
    if (input.response) {
      if (!SUBMITTAL_RESPONSES.includes(input.response)) {
        return { ok: false, error: `Unknown response: ${input.response}` };
      }
      patch.response = input.response;
    }
    if (input.response_copies !== undefined && input.response_copies !== null) {
      if (!Number.isFinite(input.response_copies) || input.response_copies < 0) {
        return { ok: false, error: "response_copies must be a non-negative number." };
      }
      patch.response_copies = input.response_copies;
    }
  }
  if (input.to_status === "voided") {
    const reason = (input.void_reason ?? "").trim();
    if (!reason) return { ok: false, error: "Void reason is required." };
    patch.voided_at = now;
    patch.voided_by_user_id = input.changed_by_user_id ?? null;
    patch.void_reason = reason;
  }

  // Race-guard: re-assert from_status in WHERE so two simultaneous status
  // changes can't both succeed (audit S2 pattern + mirror of
  // demoteCurrentPrimary fix from 2026-06-24).
  const { data: after, error: updErr } = await sb
    .from("commercial_opp_submittals")
    .update(patch)
    .eq("id", input.submittal_id)
    .eq("opportunity_id", input.opportunity_id)
    .eq("status", fromStatus)
    .select("*")
    .maybeSingle();
  if (updErr) return { ok: false, error: updErr.message };
  if (!after) {
    return { ok: false, error: "Status changed in another tab. Reload to see the latest." };
  }

  // Append status log entry.
  await sb.from("commercial_opp_submittal_status_log").insert({
    submittal_id: input.submittal_id,
    from_status: fromStatus,
    to_status: input.to_status,
    changed_by_user_id: input.changed_by_user_id ?? null,
    note: input.note ?? null,
  });

  await logUpdate(
    "commercial_opp_submittals",
    input.submittal_id,
    before,
    after,
    input.changed_by_user_id ?? null
  );
  return { ok: true, submittal: after as OpportunitySubmittal };
}

// ─── Delete (draft only) ─────────────────────────────────────────────

/**
 * Hard-delete a draft submittal. Items cascade. Non-drafts must be voided
 * (preserves audit trail). Soft-delete via parent opp.deleted_at is the
 * mechanism for "remove from view" once a submittal has been sent.
 */
export async function deleteOpportunitySubmittal(
  opportunity_id: string,
  submittal_id: string,
  deleted_by_user_id?: string | null
): Promise<{ ok: true } | { ok: false; error: string }> {
  const sb = commercialDb();

  const { data: before } = await sb
    .from("commercial_opp_submittals")
    .select("*")
    .eq("id", submittal_id)
    .eq("opportunity_id", opportunity_id)
    .maybeSingle();
  if (!before) return { ok: false, error: "Submittal not found." };
  const beforeRow = before as OpportunitySubmittal;
  if (beforeRow.status !== "draft") {
    return {
      ok: false,
      error: `Submittal is ${beforeRow.status} — only drafts can be deleted. Void it instead.`,
    };
  }

  const { error } = await sb
    .from("commercial_opp_submittals")
    .delete()
    .eq("id", submittal_id)
    .eq("opportunity_id", opportunity_id)
    .eq("status", "draft");
  if (error) return { ok: false, error: error.message };

  await logDelete(
    "commercial_opp_submittals",
    submittal_id,
    before,
    deleted_by_user_id ?? null
  );
  // Audit log already covers the cascade indirectly; not worth fanning out.
  void writeCommercialAudit({
    tableName: "commercial_opp_submittal_items",
    rowId: submittal_id,
    action: "delete",
    beforeJson: { cascade_from_submittal: submittal_id },
    userId: deleted_by_user_id ?? null,
  });
  return { ok: true };
}

// Re-export helper so callers don't need a separate import.
export { isTerminalSubmittalStatus };
