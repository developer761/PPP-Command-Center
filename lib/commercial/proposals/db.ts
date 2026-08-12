/**
 * Phase F.1 Proposals — CRUD + line-item helpers + rollup recompute.
 *
 * Every mutation is audit-logged via logInsert/logUpdate/logDelete.
 * Soft-delete pattern via `deleted_at`. Snapshot pattern on line items
 * — `unit_price_cents` freezes at line-item create so a Product
 * catalog edit doesn't rewrite a sent proposal.
 *
 * Rollup rule: total_cents = SUM(quantity × unit_price_cents) across
 * all line items where is_alternate = false. Recomputed on every
 * line-item mutation via `recomputeProposalTotal()`. Not a DB trigger
 * — kept in the app layer so the write path stays predictable.
 */

import { commercialDb } from "@/lib/commercial/db";
import { logInsert, logUpdate, logDelete } from "@/lib/commercial/audit-log";
import { paginateAll } from "@/lib/commercial/paginate";
import type { ProposalStatus } from "./constants";
import { targetForProposalStatus } from "@/lib/commercial/opportunities/auto-advance-targets";

// ────────────── types ──────────────

/** Cached header block on `commercial_proposals.header_json`. Snapshot
 *  from the account + deal at create time so the PDF stays stable if
 *  the source records are edited later. F.3 renderer reads these. */
export type ProposalHeaderJson = {
  gc_company?: string;
  gc_address_lines?: string[];
  attention?: string;
  phone?: string;
  email?: string;
  project_name?: string;
  project_address?: string;
  date_iso?: string;
  show_capital_improvement_notice?: boolean;
  // Karan 2026-07-17 (Tomco 1:1 reference match): optional proposal
  // number rendered right-aligned below the date, e.g. "No. ALT0125".
  // Free-text so Alex can use whatever numbering scheme the GC wants.
  // Falls back to `R{revision_number}` on the PDF if absent.
  proposal_number?: string;
};

/** Snapshotted estimator sign-off. Frozen at proposal create so the
 *  PDF footer doesn't shift if the estimator's contact info changes. */
export type ProposalEstimatorSnapshot = {
  name?: string;
  title?: string;
  phone?: string;
  email?: string;
};

export type CommercialProposal = {
  id: string;
  opportunity_id: string;
  revision_number: number;
  parent_proposal_id: string | null;
  header_json: ProposalHeaderJson;
  intro_text_override: string | null;
  alternate_notes: string | null;
  bid_notes: string | null;
  exclusion_ids: string[];
  /** Phase F.5: per-proposal one-off exclusion text lines that don't
   *  belong to the shared library. Rendered AFTER exclusion_ids in the
   *  PDF, in the order Alex added them. */
  custom_exclusions: string[];
  total_cents: number;
  /** R1b: adjustable final price. NULL = use the line-item sum; a value overrides
   *  the total. Flows INTO total_cents (the contract number) via recompute. */
  final_price_override_cents: number | null;
  /** R1c: Bid Set date shown on the client proposal (null = hidden). */
  bid_set_date: string | null;
  pdf_show_line_prices: boolean;
  estimator_snapshot_json: ProposalEstimatorSnapshot;
  status: ProposalStatus;
  sent_at: string | null;
  approved_at: string | null;
  expired_at: string | null;
  // R1d — in-app approval (approved_at above is the WON/LOST stamp, NOT approval).
  approval_requested_by_user_id: string | null;
  approval_requested_at: string | null;
  approved_by_user_id: string | null;
  approval_approved_at: string | null;
  changes_requested_note: string | null;
  changes_requested_at: string | null;
  snapshot_document_id: string | null;
  created_at: string;
  updated_at: string;
  created_by_user_id: string | null;
  updated_by_user_id: string | null;
  deleted_at: string | null;
  // Migration 069 (Katie 2026-07-20) — global sequential ID rendered
  // as PROP-#### in every proposal surface. Assigned by DB trigger on
  // insert; nullable at column level for backfill compat only.
  proposal_seq: number | null;
};

/** Format a proposal_seq int → "PROP-0001" for UI. Null → empty
 *  string so callers can `{formatProposalNumber(p.proposal_seq)}`
 *  without a truthy check. */
export function formatProposalNumber(seq: number | null | undefined): string {
  if (seq == null) return "";
  return `PROP-${String(seq).padStart(4, "0")}`;
}

export type CommercialProposalLineItem = {
  id: string;
  proposal_id: string;
  product_id: string | null;
  // Migration 071 (2026-07-21): snapshotted product display name, e.g.
  // "HM Frame & Wood Door (Seal & Poly)". Rendered as the bold lead on the
  // PDF with description below. NULL for free-text/legacy rows (renderer
  // falls back to parsing a bold-lead out of the description).
  product_name: string | null;
  description: string;
  quantity: number;
  unit: string;
  unit_price_cents: number;
  is_alternate: boolean;
  position: number;
  // F.6 (2026-07-19): optional phase label ("Phase 1", "Base contract").
  // NULL = ungrouped. Renderer groups by phase when any item has one set;
  // otherwise falls back to flat rendering for pre-F.6 proposals.
  phase: string | null;
  // Migration 063 (2026-07-19, Katie): labor row flag. Labor rows have
  // qty = hours, unit = "hour", unit_price_cents = hourly rate. They
  // roll into TOTAL like inclusions but render under a "Labor:" section
  // on the customer PDF.
  is_labor: boolean;
  /** R1a: print this line's price on the client PDF (default true). Hidden lines
   *  still count toward the proposal total. */
  show_price: boolean;
  created_at: string;
  updated_at: string;
};

// ────────────── proposal CRUD ──────────────

export type CreateProposalInput = {
  opportunity_id: string;
  header_json?: ProposalHeaderJson;
  intro_text_override?: string | null;
  alternate_notes?: string | null;
  bid_notes?: string | null;
  exclusion_ids?: string[];
  custom_exclusions?: string[];
  pdf_show_line_prices?: boolean;
  estimator_snapshot_json?: ProposalEstimatorSnapshot;
  parent_proposal_id?: string | null;
  created_by_user_id?: string | null;
};

/**
 * Idempotency guard for the create-a-proposal route.
 *
 * `/proposal/new` creates on GET render and then redirects, so pressing
 * BROWSER BACK from the editor re-renders it and used to mint a SECOND
 * proposal — the likely source of "why do I have extra proposals" (audit
 * 2026-08). Rather than restructure every entry point into a POST (the
 * picker, the bump link, and any bookmark), the route asks this first: is
 * there already a proposal that this exact request would have produced?
 *
 * "Already produced" is deliberately narrow, so a user who genuinely wants
 * a second revision still gets one:
 *
 *   - Fresh proposal (no parent): the newest DRAFT on this deal, by this
 *     user, created inside the window, that is still UNTOUCHED — no line
 *     items, no notes, no name, no price override. The moment they type
 *     anything into it, the next visit correctly makes a new one.
 *   - Bump (with parent): the newest DRAFT on this deal by this user with
 *     the SAME parent inside the window. A bump copies the parent's lines
 *     forward, so "untouched" can't be the test here; two bumps of one
 *     parent within minutes is the back button, not intent. Bumping the
 *     new revision instead is the way to get a genuine second one.
 *
 * Returns the proposal to reuse, or null to create fresh.
 */
const PROPOSAL_REUSE_WINDOW_MS = 6 * 60 * 60 * 1000; // 6 hours

export async function findReusableDraftProposal(input: {
  opportunity_id: string;
  parent_proposal_id: string | null;
  created_by_user_id: string | null;
  /**
   * The project_name hydration WOULD stamp onto a fresh proposal
   * (`ctx.header.project_name`). `header_json.project_name` is auto-populated at
   * create time (`title_override || client_name || derivedOppName`) and is
   * essentially NEVER empty for a real deal, so testing it for mere presence
   * made every fresh draft look "touched" and the back-button duplicate bug
   * survived (audit 2026-08 re-check). We instead treat the draft as untouched
   * only while its name still equals the hydration default — a user rename is a
   * real touch and correctly yields a new proposal on the next visit.
   */
  hydrated_project_name?: string | null;
}): Promise<CommercialProposal | null> {
  if (!input.created_by_user_id) return null;
  const sb = commercialDb();
  let q = sb
    .from("commercial_proposals")
    .select("*")
    .eq("opportunity_id", input.opportunity_id)
    .eq("created_by_user_id", input.created_by_user_id)
    .eq("status", "draft")
    .is("deleted_at", null)
    .order("created_at", { ascending: false })
    .limit(1);
  q = input.parent_proposal_id
    ? q.eq("parent_proposal_id", input.parent_proposal_id)
    : q.is("parent_proposal_id", null);
  const { data } = await q.maybeSingle();
  const candidate = data as CommercialProposal | null;
  if (!candidate) return null;

  const age = Date.now() - new Date(candidate.created_at).getTime();
  // Number.isFinite guards a malformed created_at — an unparseable date
  // yields NaN, and NaN < window is false, so it falls through to a fresh
  // create rather than silently reusing an ancient row.
  if (!Number.isFinite(age) || age > PROPOSAL_REUSE_WINDOW_MS) return null;

  if (input.parent_proposal_id) return candidate;

  // Fresh-proposal path: only reuse if nothing has been entered yet. The
  // project_name is auto-hydrated at create time, so "untouched" means the name
  // still MATCHES the hydration default (not merely "is empty" — it never is).
  // A rename diverges from the default and correctly counts as a touch.
  const nameStillDefault =
    (candidate.header_json?.project_name ?? null) ===
    (input.hydrated_project_name ?? null);
  const untouched =
    !candidate.intro_text_override &&
    !candidate.alternate_notes &&
    !candidate.bid_notes &&
    !candidate.bid_set_date &&
    candidate.final_price_override_cents == null &&
    nameStillDefault &&
    candidate.total_cents === 0;
  if (!untouched) return null;

  const items = await listLineItemsForProposal(candidate.id);
  return items.length === 0 ? candidate : null;
}

export async function createProposal(
  input: CreateProposalInput
): Promise<
  | { ok: true; proposal: CommercialProposal }
  | { ok: false; error: string }
> {
  const sb = commercialDb();
  // F.1 post-audit fix: previously did SELECT max + INSERT which raced
  // on concurrent bumps. Now route through the atomic
  // create_commercial_proposal_revision(...) RPC that SELECT ... FOR
  // UPDATEs the parent opportunity row so concurrent bumps queue
  // instead of colliding. If the RPC isn't installed yet (rare — post-
  // migration), fall back to the legacy path with the 23505 retry hint.
  const { data: rpcResult, error: rpcErr } = await sb.rpc(
    "create_commercial_proposal_revision",
    {
      p_opportunity_id: input.opportunity_id,
      p_parent_proposal_id: input.parent_proposal_id ?? null,
      p_header_json: input.header_json ?? {},
      p_intro_text_override: input.intro_text_override ?? null,
      p_alternate_notes: input.alternate_notes ?? null,
      p_bid_notes: input.bid_notes ?? null,
      p_exclusion_ids: input.exclusion_ids ?? [],
      p_pdf_show_line_prices: input.pdf_show_line_prices ?? false,
      p_estimator_snapshot_json: input.estimator_snapshot_json ?? {},
      p_created_by_user_id: input.created_by_user_id ?? null,
    }
  );
  if (!rpcErr && rpcResult) {
    const newId = rpcResult as string;
    // F.5: custom_exclusions isn't in the RPC signature — apply as a
    // patch right after so bump-forward works without a new migration.
    if (input.custom_exclusions && input.custom_exclusions.length > 0) {
      await sb
        .from("commercial_proposals")
        .update({ custom_exclusions: input.custom_exclusions })
        .eq("id", newId);
    }
    const { data: row } = await sb
      .from("commercial_proposals")
      .select("*")
      .eq("id", newId)
      .single();
    const proposal = row as CommercialProposal;
    await logInsert(
      "commercial_proposals",
      proposal.id,
      proposal,
      input.created_by_user_id ?? null
    );
    if (input.parent_proposal_id) {
      await updateProposalStatus({
        id: input.parent_proposal_id,
        to_status: "superseded",
        acting_user_id: input.created_by_user_id ?? null,
      });
      // Karan 2026-07-16 had this walk the deal BACK to (estimating,
      // estimating) whenever a revision bump created a fresh draft, so the
      // kanban wouldn't read "Proposal Sent" over a draft.
      //
      // REMOVED with the auto-advance engine. Every state it could fire from
      // was ahead of Estimating, making it purely a backward writer — the
      // first half of the ping-pong. Open an R2 draft on a deal at Proposal
      // and this yanked it to Estimating immediately under the creator's
      // name; the reconciler then fought over it on every later page load,
      // emailing the team on each swing.
      //
      // Automatic moves are forward-only now, and a new draft is not evidence
      // that a deal regressed — an estimator revising a sent proposal is
      // normal, and the deal is still at Proposal. Re-pricing a deal is a
      // person dragging it back, which the engine leaves alone.
    }
    return { ok: true, proposal };
  }

  // Fallback path (RPC not installed on this env yet).
  const { data: existing } = await sb
    .from("commercial_proposals")
    .select("revision_number")
    .eq("opportunity_id", input.opportunity_id)
    .is("deleted_at", null)
    .order("revision_number", { ascending: false })
    .limit(1);
  const nextRev = ((existing?.[0] as { revision_number?: number } | undefined)
    ?.revision_number ?? 0) + 1;
  const { data, error } = await sb
    .from("commercial_proposals")
    .insert({
      opportunity_id: input.opportunity_id,
      revision_number: nextRev,
      parent_proposal_id: input.parent_proposal_id ?? null,
      header_json: input.header_json ?? {},
      intro_text_override: input.intro_text_override ?? null,
      alternate_notes: input.alternate_notes ?? null,
      bid_notes: input.bid_notes ?? null,
      exclusion_ids: input.exclusion_ids ?? [],
      custom_exclusions: input.custom_exclusions ?? [],
      pdf_show_line_prices: input.pdf_show_line_prices ?? false,
      estimator_snapshot_json: input.estimator_snapshot_json ?? {},
      status: "draft",
      total_cents: 0,
      created_by_user_id: input.created_by_user_id ?? null,
      updated_by_user_id: input.created_by_user_id ?? null,
    })
    .select("*")
    .single();
  if (error) {
    if (error.code === "23505" || /unique/i.test(error.message)) {
      return {
        ok: false,
        error:
          "Another revision landed at the same number — reload and try again.",
      };
    }
    return { ok: false, error: error.message };
  }
  const proposal = data as CommercialProposal;
  await logInsert(
    "commercial_proposals",
    proposal.id,
    proposal,
    input.created_by_user_id ?? null
  );
  if (input.parent_proposal_id) {
    await updateProposalStatus({
      id: input.parent_proposal_id,
      to_status: "superseded",
      acting_user_id: input.created_by_user_id ?? null,
    });
  }
  return { ok: true, proposal };
}

export type UpdateProposalInput = {
  id: string;
  header_json?: ProposalHeaderJson;
  intro_text_override?: string | null;
  alternate_notes?: string | null;
  bid_notes?: string | null;
  exclusion_ids?: string[];
  custom_exclusions?: string[];
  pdf_show_line_prices?: boolean;
  /** R1b: null clears back to the line-item sum; a value (cents, ≥0) overrides. */
  final_price_override_cents?: number | null;
  /** R1c: Bid Set date (YYYY-MM-DD) or null. */
  bid_set_date?: string | null;
  estimator_snapshot_json?: ProposalEstimatorSnapshot;
  updated_by_user_id?: string | null;
};

export async function updateProposal(
  input: UpdateProposalInput
): Promise<
  | { ok: true; proposal: CommercialProposal }
  | { ok: false; error: string }
> {
  const patch: Record<string, unknown> = {
    updated_by_user_id: input.updated_by_user_id ?? null,
  };
  if (input.header_json !== undefined) patch.header_json = input.header_json;
  if (input.intro_text_override !== undefined)
    patch.intro_text_override = input.intro_text_override;
  if (input.alternate_notes !== undefined)
    patch.alternate_notes = input.alternate_notes;
  if (input.bid_notes !== undefined) patch.bid_notes = input.bid_notes;
  if (input.exclusion_ids !== undefined) patch.exclusion_ids = input.exclusion_ids;
  if (input.custom_exclusions !== undefined) patch.custom_exclusions = input.custom_exclusions;
  if (input.pdf_show_line_prices !== undefined)
    patch.pdf_show_line_prices = input.pdf_show_line_prices;
  if (input.final_price_override_cents !== undefined) {
    const v = input.final_price_override_cents;
    if (v != null && (!Number.isFinite(v) || v < 0)) {
      return { ok: false, error: "Final price can't be negative." };
    }
    patch.final_price_override_cents = v == null ? null : Math.round(v);
  }
  if (input.bid_set_date !== undefined) patch.bid_set_date = input.bid_set_date || null;
  if (input.estimator_snapshot_json !== undefined)
    patch.estimator_snapshot_json = input.estimator_snapshot_json;

  const sb = commercialDb();
  const { data: before } = await sb
    .from("commercial_proposals")
    .select("*")
    .eq("id", input.id)
    .is("deleted_at", null)
    .maybeSingle();
  if (!before) return { ok: false, error: "Proposal not found." };
  // Karan 2026-07-20 (autosave fix): draft-only guard. A Sent/Won/Lost
  // proposal is the frozen legal record — editing it silently would
  // corrupt the audit trail + let autosave reset customer-visible
  // fields on a document the GC already has a PDF copy of. Reject
  // with a friendly error so the client can render a read-only banner.
  const beforeStatus = (before as { status?: string }).status;
  if (beforeStatus && beforeStatus !== "draft") {
    return {
      ok: false,
      error: `Only draft proposals can be edited. This one is ${beforeStatus}. Bump a new revision to make changes.`,
    };
  }
  const { data: after, error } = await sb
    .from("commercial_proposals")
    .update(patch)
    .eq("id", input.id)
    .eq("status", "draft") // defense-in-depth against status flip mid-request
    .select("*")
    .single();
  if (error) return { ok: false, error: error.message };
  const proposal = after as CommercialProposal;
  // R1b: the override drives total_cents (the contract number) — recompute when
  // it's set/cleared so AIA/invoicing/KPIs use the right number.
  if (input.final_price_override_cents !== undefined) {
    await recomputeProposalTotal(proposal.id, input.updated_by_user_id ?? null);
    const ov = input.final_price_override_cents;
    proposal.total_cents = ov != null ? Math.round(ov) : await proposalLineItemSumCents(proposal.id);
  }
  await logUpdate(
    "commercial_proposals",
    proposal.id,
    before,
    proposal,
    input.updated_by_user_id ?? null
  );
  return { ok: true, proposal };
}

/**
 * Is the deal ALREADY in a state consistent with what the proposal implies?
 *
 * Both proposal→deal paths (the live cascade in updateProposalStatus and
 * the drift-healer in reconcileDealStatesFromProposals) ask this before
 * flipping a deal. Without it the healer doesn't just fail to help — it
 * actively destroys detail the user set on purpose, on every page load,
 * because it runs on render of /commercial/opportunities and
 * /commercial/proposals.
 *
 * The two states it protects are exactly the two the deal carries that a
 * proposal status can't express:
 *
 *   - A deal anywhere in QUALIFYING (Solicitation, RFP, or Qualifying ·
 *     Estimating) with a DRAFT proposal. Drafting a price doesn't mean
 *     we've stopped qualifying — Qualifying is upstream of Estimating, not
 *     stale relative to it. The live cascade already had this guard (as an
 *     inline draft-at-qualifying special case, now redundant but harmless);
 *     the healer never did, so a Request-for-Proposal deal jumped to
 *     Estimating the moment anyone opened the pipeline. Note this is
 *     deliberately the whole Qualifying stage, not RFP alone — it mirrors
 *     the long-standing inline behaviour rather than narrowing it.
 *
 *   - A deal in Proposal · Follow-Up with a SENT proposal. Follow-Up is a
 *     refinement OF sent ("it's out, we're chasing it"), not drift away
 *     from it. The healer read the tuple mismatch as drift and reset the
 *     deal to Sent, so the Follow-Up tag silently evaporated.
 */
function dealAlreadyConsistentWithProposal(
  deal: { status: string; sub_status: string | null },
  target: { status: string; sub: string }
): boolean {
  if (deal.status === target.status && deal.sub_status === target.sub) {
    return true;
  }
  // Draft proposal (→ Estimating · Estimating) is valid anywhere in
  // Qualifying, including its RFP stage.
  if (
    target.status === "estimating" &&
    target.sub === "estimating" &&
    deal.status === "qualifying"
  ) {
    return true;
  }
  // Follow-Up is a valid refinement of Sent.
  if (
    target.status === "proposal" &&
    target.sub === "sent" &&
    deal.status === "proposal" &&
    deal.sub_status === "follow_up"
  ) {
    return true;
  }
  return false;
}

export async function updateProposalStatus(input: {
  id: string;
  to_status: ProposalStatus;
  acting_user_id: string | null;
  /** Karan 2026-07-15: internal-only flag to skip the parent-opp
   *  cascade. Set by cascades coming FROM the opp side so we don't
   *  double-fire (opp cascade → proposal update → proposal cascade →
   *  opp update → ping-pong). Public callers should leave this false
   *  so proposal moves always align the opp automatically. */
  _skipOppCascade?: boolean;
}): Promise<
  | { ok: true; proposal: CommercialProposal }
  | { ok: false; error: string }
> {
  const sb = commercialDb();
  const { data: before } = await sb
    .from("commercial_proposals")
    .select("*")
    .eq("id", input.id)
    .is("deleted_at", null)
    .maybeSingle();
  if (!before) return { ok: false, error: "Proposal not found." };
  const beforeRow = before as CommercialProposal;
  const patch: Record<string, unknown> = {
    status: input.to_status,
    updated_by_user_id: input.acting_user_id ?? null,
  };
  if (input.to_status === "sent") patch.sent_at = new Date().toISOString();
  if (input.to_status === "won" || input.to_status === "lost") {
    patch.approved_at = new Date().toISOString();
  }
  // F.1 post-audit fix: expired_at was missing. Now stamped on expiry
  // so AR reporting can distinguish "customer took too long" from
  // "customer explicitly said no" (Lost).
  if (input.to_status === "expired") {
    patch.expired_at = new Date().toISOString();
  }
  const { data: after, error } = await sb
    .from("commercial_proposals")
    .update(patch)
    .eq("id", input.id)
    .select("*")
    .single();
  if (error) return { ok: false, error: error.message };
  const proposal = after as CommercialProposal;
  await logUpdate(
    "commercial_proposals",
    proposal.id,
    before,
    proposal,
    input.acting_user_id
  );

  // Karan 2026-07-15: cascade proposal state → parent deal column so
  // both pipeline surfaces always stay aligned no matter which side
  // the user moves. Mapping:
  //   proposal.status = draft → deal Proposal Drafted (estimating + proposal_pending_approval)
  //                              (only if the deal is behind that stage — never yank forward-progress backward)
  //   proposal.status = pending_approval → deal Proposal Drafted (estimating + proposal_pending_approval)
  //   proposal.status = sent → deal Proposal Sent (proposal + sent)
  //   proposal.status = won → deal Won (pre_sale_closed + won)
  //   proposal.status = lost → deal Lost (pre_sale_closed + lost)
  //   proposal.status = expired / superseded → no deal cascade
  //     (expired = customer sat on it; superseded = a newer revision
  //      exists that's already carrying the deal state)
  //
  // Guardrail: never REVERSE a deal that's already past pre_sale (i.e.
  // in delivery: pre_construction / in_progress / billing). If the
  // crew is on-site, moving the deal back to Estimating because the
  // user reshuffled a proposal draft would be catastrophic. Post-sale
  // deals ignore the cascade.
  if (!input._skipOppCascade && beforeRow.status !== input.to_status) {
    try {
      const { data: oppRow } = await sb
        .from("commercial_opportunities")
        .select("id, status, sub_status")
        .eq("id", beforeRow.opportunity_id)
        .is("deleted_at", null)
        .maybeSingle();
      const opp = oppRow as { id: string; status: string; sub_status: string | null } | null;
      const postSaleStatuses = new Set([
        "pre_construction",
        "in_progress",
        "billing",
        "post_sale_closed",
      ]);
      if (opp && !postSaleStatuses.has(opp.status)) {
        // Karan 2026-07-16 (round 2) — canonical bidirectional mapping:
        //   Qualifying / Estimating(plain)            ↔ Draft
        //   Estimating + Proposal Pending Approval    ↔ Pending Approval
        //   Proposal (sent / follow_up)               ↔ Sent
        //   Pre-Con / In Progress / Billing           ← don't touch proposal (delivery-phase; whatever proposal state was, stays)
        //   Pre-Sale Closed + Won                     ↔ Won
        //   Pre-Sale Closed + Lost                    ↔ Lost
        //
        // Draft special case: valid at BOTH Qualifying and Estimating.
        // If deal is already Qualifying, don't yank forward to
        // Estimating — Draft is fine at Qualifying too. Skip.
        if (input.to_status === "draft" && opp.status === "qualifying") {
          // Valid deal state for a draft proposal; no cascade needed.
        } else {
        let dealStatus: string | null = null;
        let dealSub: string | null = null;
        switch (input.to_status) {
          case "draft":
            dealStatus = "estimating";
            dealSub = "estimating";
            break;
          case "pending_approval":
            dealStatus = "estimating";
            dealSub = "proposal_pending_approval";
            break;
          case "approved":
            // R1d: internal approval — the customer hasn't seen anything yet,
            // so keep the deal in Estimating (proposal awaiting the send). Same
            // tuple as pending_approval; the deal only advances on Send.
            dealStatus = "estimating";
            dealSub = "proposal_pending_approval";
            break;
          case "sent":
            dealStatus = "proposal";
            dealSub = "sent";
            break;
          case "won":
            dealStatus = "pre_sale_closed";
            dealSub = "won";
            break;
          case "lost":
            dealStatus = "pre_sale_closed";
            dealSub = "lost";
            break;
          // expired / superseded fall through — no cascade.
        }
        // Only fire if the deal isn't already in a consistent state —
        // which includes RFP-with-a-draft and Follow-Up-with-a-sent, not
        // just an exact tuple match.
        if (
          dealStatus &&
          !dealAlreadyConsistentWithProposal(
            { status: opp.status, sub_status: opp.sub_status },
            { status: dealStatus, sub: dealSub ?? "" }
          )
        ) {
          const autoKey = targetForProposalStatus(input.to_status);
          if (autoKey) {
            // Forward-only, through the shared engine. This cascade used to
            // move the deal in whichever direction the proposal implied, so
            // dragging a sent proposal back to Draft dragged the deal back to
            // Estimating with it. A person walking a proposal backwards is
            // usually correcting the PROPOSAL, not declaring the deal
            // regressed; if they mean the deal too, they move the deal.
            const { autoAdvanceOpportunity } = await import(
              "@/lib/commercial/opportunities/auto-advance"
            );
            const res = await autoAdvanceOpportunity({
              oppId: beforeRow.opportunity_id,
              target: autoKey,
              // The proposal changed in this request, so it is by definition
              // the most current signal — no earlier human move outranks it.
              artifactAt: new Date().toISOString(),
              source: "auto_advance",
              reason: `Proposal marked ${input.to_status.replace(/_/g, " ")}`,
              actingUserId: input.acting_user_id,
            });
            if (!res.moved && res.reason === "error") {
              console.warn(
                `[updateProposalStatus] deal cascade failed for ${beforeRow.opportunity_id}: ${res.detail}`
              );
            }
          } else {
            // `lost` has no automatic target on purpose — closing a deal as
            // lost requires a loss_reason, and the engine must never invent
            // one. A person marking the proposal lost is the decision, so this
            // stays a direct, user-attributed write.
            const { changeOpportunityStatus } = await import(
              "@/lib/commercial/opportunities/status"
            );
            const flip = await changeOpportunityStatus({
              opp_id: beforeRow.opportunity_id,
              // Cast — the switch above only sets dealStatus to values
              // that are valid OpportunityStatus enum members.
              to_status: dealStatus as Parameters<typeof changeOpportunityStatus>[0]["to_status"],
              to_sub_status: dealSub,
              acting_user_id: input.acting_user_id,
              _skipDagCheck: true,
              // Karan 2026-07-15 (round 6): don't let the deal update
              // fan back out to sibling proposals — this cascade was
              // triggered by a proposal move, so promoting/demoting
              // siblings would make "one card moved" look like "all
              // cards moved together" on the proposal kanban.
              _skipProposalCascade: true,
            });
            if (!flip.ok) {
              console.warn(
                `[updateProposalStatus] deal cascade failed for ${beforeRow.opportunity_id}: ${flip.error}`
              );
            }
          }
        }
        } // end of else (draft-at-qualifying skip)
      }
    } catch (err) {
      console.warn(
        "[updateProposalStatus] deal cascade threw:",
        err instanceof Error ? err.message : String(err)
      );
    }
  }

  return { ok: true, proposal };
}

export async function softDeleteProposal(
  id: string,
  actorUserId: string | null
): Promise<{ ok: true } | { ok: false; error: string }> {
  const sb = commercialDb();
  const { data: before } = await sb
    .from("commercial_proposals")
    .select("*")
    .eq("id", id)
    .is("deleted_at", null)
    .maybeSingle();
  if (!before) return { ok: false, error: "Proposal not found." };
  // Round-3 audit fix: backend guard on status. The editor UI only
  // shows the Delete button on drafts, but a hand-crafted POST from
  // devtools or a browser back-button retry could otherwise nuke a
  // Sent/Won/Lost proposal + orphan its audit trail. Drafts only.
  const beforeRow = before as CommercialProposal;
  if (beforeRow.status !== "draft") {
    return {
      ok: false,
      error: `Only draft proposals can be deleted. This one is ${beforeRow.status}. If you need to invalidate it, bump a new revision instead.`,
    };
  }
  const { error } = await sb
    .from("commercial_proposals")
    .update({
      deleted_at: new Date().toISOString(),
      updated_by_user_id: actorUserId,
    })
    .eq("id", id)
    .eq("status", "draft"); // defense in depth against a status flip mid-request
  if (error) return { ok: false, error: error.message };
  await logDelete("commercial_proposals", id, before, actorUserId);
  return { ok: true };
}

/** Karan 2026-07-15: shared "mark proposal Won / Lost" side-effects
 *  helper. The proposal-editor button, the /commercial/proposals kanban
 *  drop, and (future) mobile share-sheet all call THIS so the outcome
 *  is stamped identically everywhere — proposal.status flips, parent
 *  deal flips to pre_sale_closed/{won|lost}, and the caller decides
 *  where to redirect the user (Won → stay on proposal; Lost → debrief
 *  form). */
export async function markProposalOutcome(input: {
  proposal_id: string;
  outcome: "won" | "lost";
  actor_user_id: string | null;
}): Promise<
  | {
      ok: true;
      proposal: CommercialProposal;
      opportunity_id: string;
      account_id: string;
      /** Non-null when the parent deal was already in delivery and was
       *  therefore left alone — carries that status for the caller's note. */
      deal_left_in_delivery?: string | null;
    }
  | { ok: false; error: string }
> {
  const sb = commercialDb();
  // Verify the proposal exists + not soft-deleted + get parent opp id.
  const { data: proposalRow } = await sb
    .from("commercial_proposals")
    .select("id, opportunity_id, status")
    .eq("id", input.proposal_id)
    .is("deleted_at", null)
    .maybeSingle();
  if (!proposalRow) return { ok: false, error: "Proposal not found." };
  const proposalBefore = proposalRow as { id: string; opportunity_id: string; status: string };
  // 2026-07-28 re-audit: a SUPERSEDED revision (replaced by a newer one) must
  // not be markable Won/Lost — the kanban still renders superseded cards as
  // draggable, so dragging the stale R1 to Won would mark the replaced revision
  // and cascade the deal off a dead record. Everything else stays free-drag.
  if (proposalBefore.status === "superseded") {
    return { ok: false, error: "This revision was replaced by a newer one — mark the latest revision instead." };
  }
  // Karan 2026-07-15 (round 5): dropped the "only Sent can be Won/Lost"
  // guard. The proposals kanban is fully free-drag now — a user might
  // decide a Draft proposal represents a verbal-yes deal and drag it
  // straight to Won, skipping the send step. Same for verbal-no →
  // Lost. Refusing the transition would block valid workflows. The
  // proposal→deal cascade handles the alignment regardless of source.
  // (Won/Lost from won/lost still gets caught by outcome-route reopen
  // detection before this helper fires.)
  // Flip the proposal via the same helper the editor uses.
  const propResult = await updateProposalStatus({
    id: input.proposal_id,
    to_status: input.outcome,
    acting_user_id: input.actor_user_id,
  });
  if (!propResult.ok) return { ok: false, error: propResult.error };
  // Grab account_id for the caller's redirect (Lost needs to land on
  // /commercial/accounts/[id]/debrief/[dealId]).
  const { data: oppRow } = await sb
    .from("commercial_opportunities")
    .select("account_id")
    .eq("id", proposalBefore.opportunity_id)
    .maybeSingle();
  const accountId = (oppRow as { account_id: string } | null)?.account_id ?? null;
  // Flip parent deal — best-effort, and NOT unconditionally.
  //
  // Karan 2026-08: "I tried putting the proposal into win. The logic is a bit
  // weird." This was the weird part. The flip ran with _skipDagCheck and no
  // guard, so marking a proposal Won on a deal that had already moved INTO
  // DELIVERY (pre-construction / in progress / billing) yanked that deal
  // backwards to "Closed Won" — a crew on site, and the board says the job is
  // sitting in the closed cluster. It's also the natural thing to do: you win
  // the job, work starts, then someone tidies up by marking the proposal Won.
  //
  // A deal in delivery is ALREADY won — that's what delivery means — so the
  // correct action is to leave it exactly where it is. The proposal still
  // flips; only the deal is left alone. Mirrors the same post-sale skip
  // updateProposalStatus's cascade has always had.
  //
  // Lost gets the same treatment: marking a proposal Lost on a job already in
  // production is a data-entry slip, not a real state change, and un-winning a
  // live job is far more destructive than leaving a proposal mislabelled.
  const POST_SALE = new Set([
    "pre_construction",
    "in_progress",
    "billing",
    "post_sale_closed",
  ]);
  let dealLeftInDelivery: string | null = null;
  try {
    const { data: dealRow } = await sb
      .from("commercial_opportunities")
      .select("status")
      .eq("id", proposalBefore.opportunity_id)
      .maybeSingle();
    const dealStatus = (dealRow as { status: string } | null)?.status ?? null;
    if (dealStatus && POST_SALE.has(dealStatus)) {
      dealLeftInDelivery = dealStatus;
    } else {
      const { changeOpportunityStatus } = await import(
        "@/lib/commercial/opportunities/status"
      );
      const flip = await changeOpportunityStatus({
        opp_id: proposalBefore.opportunity_id,
        to_status: "pre_sale_closed",
        to_sub_status: input.outcome,
        acting_user_id: input.actor_user_id,
        _skipDagCheck: true,
      });
      if (!flip.ok) {
        console.warn(
          `[markProposalOutcome] opp flip failed for ${proposalBefore.opportunity_id}: ${flip.error}`
        );
      }
    }
  } catch (err) {
    console.warn(`[markProposalOutcome] opp flip threw:`, err);
  }

  // Snapshot the signed contract onto the deal. Needed HERE as well as in
  // changeOpportunityStatus because of the branch just above: when the deal is
  // already in delivery, the deal flip is deliberately skipped — so the
  // deal-side hook never fires, and a job won straight into production would
  // have no remembered contract at all. Idempotent, so the ordinary path
  // reaching both hooks is harmless.
  if (input.outcome === "won") {
    try {
      const { snapshotAcceptedContract } = await import(
        "@/lib/commercial/projects/accepted-contract"
      );
      await snapshotAcceptedContract(proposalBefore.opportunity_id);
    } catch (err) {
      console.warn(`[markProposalOutcome] accepted-contract snapshot threw:`, err);
    }
  }

  return {
    ok: true,
    proposal: propResult.proposal,
    opportunity_id: proposalBefore.opportunity_id,
    account_id: accountId ?? "",
    // Set when the deal was deliberately left in delivery. Callers surface it
    // as a small note so the user isn't left wondering why the deal didn't
    // move — silence here is what made the behaviour feel "weird".
    deal_left_in_delivery: dealLeftInDelivery,
  };
}

/** Karan 2026-07-15: reverse a Won/Lost proposal back to Sent — the
 *  undo path for accidentally marking a bid closed. Also un-flips the
 *  parent deal from pre_sale_closed back to Proposal · Sent so the
 *  two surfaces stay in sync (mirrors markProposalOutcome, but
 *  backwards).
 *
 *  Guardrail: only touches the parent deal if it's currently in
 *  pre_sale_closed. If the deal already moved forward (e.g. into
 *  pre_construction because the crew started the job), we DON'T
 *  yank it back — that would erase real work state. In that edge
 *  case the proposal reopens but the deal stays put, and Alex
 *  sees a warning banner explaining the mismatch. */
export async function reopenProposal(input: {
  proposal_id: string;
  actor_user_id: string | null;
}): Promise<
  | {
      ok: true;
      proposal: CommercialProposal;
      opportunity_id: string;
      account_id: string;
      deal_reopened: boolean;
      deal_current_status: string;
    }
  | { ok: false; error: string }
> {
  const sb = commercialDb();
  const { data: proposalRow } = await sb
    .from("commercial_proposals")
    .select("id, opportunity_id, status")
    .eq("id", input.proposal_id)
    .is("deleted_at", null)
    .maybeSingle();
  if (!proposalRow) return { ok: false, error: "Proposal not found." };
  const proposalBefore = proposalRow as {
    id: string;
    opportunity_id: string;
    status: string;
  };
  if (proposalBefore.status !== "won" && proposalBefore.status !== "lost") {
    return {
      ok: false,
      error: `Only Won or Lost proposals can be reopened. This one is ${proposalBefore.status}.`,
    };
  }
  // Flip the proposal back to Sent. updateProposalStatus stamps sent_at
  // again; we clear the approved_at flag directly since the helper only
  // sets it, doesn't clear.
  const propResult = await updateProposalStatus({
    id: input.proposal_id,
    to_status: "sent",
    acting_user_id: input.actor_user_id,
  });
  if (!propResult.ok) return { ok: false, error: propResult.error };
  // Clear approved_at (updateProposalStatus doesn't handle un-approval).
  await sb
    .from("commercial_proposals")
    .update({ approved_at: null })
    .eq("id", input.proposal_id);

  const { data: oppRow } = await sb
    .from("commercial_opportunities")
    .select("account_id, status, sub_status")
    .eq("id", proposalBefore.opportunity_id)
    .maybeSingle();
  const oppData = oppRow as {
    account_id: string;
    status: string;
    sub_status: string | null;
  } | null;
  const accountId = oppData?.account_id ?? "";
  const currentDealStatus = oppData?.status ?? "";
  let dealReopened = false;
  // Only un-flip the deal if it's still parked in pre_sale_closed —
  // otherwise we'd erase real forward progress (e.g. pre_construction).
  if (oppData && oppData.status === "pre_sale_closed") {
    try {
      const { changeOpportunityStatus } = await import(
        "@/lib/commercial/opportunities/status"
      );
      const flip = await changeOpportunityStatus({
        opp_id: proposalBefore.opportunity_id,
        to_status: "proposal",
        to_sub_status: "sent",
        acting_user_id: input.actor_user_id,
        _skipDagCheck: true,
      });
      if (flip.ok) {
        dealReopened = true;
      } else {
        console.warn(
          `[reopenProposal] deal reopen failed for ${proposalBefore.opportunity_id}: ${flip.error}`
        );
      }
    } catch (err) {
      console.warn(`[reopenProposal] deal reopen threw:`, err);
    }
  }
  return {
    ok: true,
    proposal: propResult.proposal,
    opportunity_id: proposalBefore.opportunity_id,
    account_id: accountId,
    deal_reopened: dealReopened,
    deal_current_status: currentDealStatus,
  };
}

// ════════════════════════════════════════════════════════════════════
// R1d — in-app proposal approval workflow (HARD GATE, Karan 2026-08)
//
// A proposal can no longer go straight from draft → sent. It must pass:
//    draft → (request approval) → pending_approval
//          → (APPROVER clicks Approve) → approved
//          → (Send) → sent
// Only an *approver* can flip pending_approval → approved or kick it back
// to draft (request changes / unlock). Everyone else can do everything
// else. The gate is enforced HERE (server), not just in the UI — the
// outcome route + kanban route every "approve"/"kick-back" move through
// these helpers so a hand-crafted POST or a free drag can't defeat it.
// ════════════════════════════════════════════════════════════════════

/** Is this user allowed to APPROVE proposals? APPROVAL IS AN EXPLICIT PER-USER
 *  FLAG — independent of admin status (on Commercial, everyone with access is an
 *  admin, so admin can't imply approver or the gate would be meaningless). A
 *  user can approve ONLY if their email is in the operating company's
 *  `approver_emails` list, toggled on Settings → Access. Everyone else can build
 *  + edit + send-for-approval, but cannot approve. Deactivated / access-revoked
 *  users can't approve even if still listed. */
export async function isProposalApprover(userId: string): Promise<boolean> {
  if (!userId) return false;
  const sb = commercialDb();
  const { data: prof } = await sb
    .from("profiles")
    .select("email, is_active, has_new_platform_access")
    .eq("user_id", userId)
    .maybeSingle();
  const p = prof as
    | { email?: string | null; is_active?: boolean | null; has_new_platform_access?: boolean | null }
    | null;
  if (!p) return false;
  if (p.is_active === false || p.has_new_platform_access === false) return false;
  const email = p.email ?? null;
  if (!email) return false;

  const { normalizeEmail } = await import("@/lib/auth/admin");
  const { getOperatingCompany } = await import(
    "@/lib/commercial/operating-company/db"
  );
  const oc = await getOperatingCompany();
  const norm = normalizeEmail(email);
  if (oc.approver_emails.some((e) => normalizeEmail(e) === norm)) return true;

  // ADMIN FALLBACK. `approver_emails` defaults to '{}' (migration 104) and is
  // never seeded, so without this NOBODY could approve on a fresh install:
  // Kim clicks "Send for approval", the proposal locks out of draft, sendProposal
  // refuses anything not `approved`, and the only way out is Withdraw — every
  // proposal permanently stuck, platform-wide, with no error to explain it.
  //
  // Two places in the product already TELL the user this is how it works
  // ("in addition to any admin" on the operating-company type; "admins are
  // always approvers" on Settings → Access). The behaviour was the thing that
  // was wrong, not the copy.
  const { isAdminEmail } = await import("@/lib/auth/admin");
  const { data: adminRow } = await sb
    .from("profiles")
    .select("is_admin")
    .eq("user_id", userId)
    .maybeSingle();
  return (adminRow as { is_admin?: boolean } | null)?.is_admin === true || isAdminEmail(email);
}

/** Resolve the set of user IDs allowed to approve proposals — the fanout target
 *  for a "please approve" notification. Exactly the users whose email is in
 *  `approver_emails` (the explicit toggle list), restricted to ACTIVE profiles
 *  that still have Commercial access. Independent of admin status. */
export async function listProposalApproverUserIds(): Promise<string[]> {
  const sb = commercialDb();
  const { getOperatingCompany } = await import(
    "@/lib/commercial/operating-company/db"
  );
  const oc = await getOperatingCompany();
  const { normalizeEmail } = await import("@/lib/auth/admin");
  const approverEmails = new Set(oc.approver_emails.map((e) => normalizeEmail(e)));

  const { data: profs } = await sb
    .from("profiles")
    .select("user_id, email, is_active, has_new_platform_access, is_admin");
  const rows = (profs ?? []) as Array<{
    user_id: string;
    email: string | null;
    is_active: boolean | null;
    has_new_platform_access: boolean | null;
    is_admin: boolean | null;
  }>;

  // Mirrors isProposalApprover: admins always count. Without this the request
  // notification fanned out to NOBODY when approver_emails was empty (its
  // default), so the request was silent as well as unactionable — the early
  // `size === 0` return made that the common case, not an edge one.
  const { isAdminEmail } = await import("@/lib/auth/admin");
  const out = new Set<string>();
  for (const r of rows) {
    if (r.is_active === false) continue;
    if (r.has_new_platform_access === false) continue;
    const norm = normalizeEmail(r.email);
    if (norm && approverEmails.has(norm)) out.add(r.user_id);
    else if (r.is_admin === true || isAdminEmail(r.email)) out.add(r.user_id);
  }
  return Array.from(out);
}

/** RUX-6: the user IDs to CC on a proposal decision (approved / changes-
 *  requested) — the "receivers" toggled on Settings → Access. Same active +
 *  has-access filter as the approver list. Independent of approver/admin. */
export async function listProposalReceiverUserIds(): Promise<string[]> {
  const sb = commercialDb();
  const { getOperatingCompany } = await import(
    "@/lib/commercial/operating-company/db"
  );
  const oc = await getOperatingCompany();
  const { normalizeEmail } = await import("@/lib/auth/admin");
  const receiverEmails = new Set((oc.receiver_emails ?? []).map((e) => normalizeEmail(e)));
  if (receiverEmails.size === 0) return [];

  const { data: profs } = await sb
    .from("profiles")
    .select("user_id, email, is_active, has_new_platform_access");
  const rows = (profs ?? []) as Array<{
    user_id: string;
    email: string | null;
    is_active: boolean | null;
    has_new_platform_access: boolean | null;
  }>;
  const out = new Set<string>();
  for (const r of rows) {
    if (r.is_active === false) continue;
    if (r.has_new_platform_access === false) continue;
    const norm = normalizeEmail(r.email);
    if (norm && receiverEmails.has(norm)) out.add(r.user_id);
  }
  return Array.from(out);
}

/** Fan a proposal-decision notification out to the receivers (Settings →
 *  Access), skipping anyone already notified (the actor + the requester).
 *  Best-effort — a failure never blocks the decision. */
async function notifyProposalReceivers(input: {
  decision: "approved" | "changes_requested";
  proposal: { id: string; revision_number: number; opportunity_id: string; header_json: { gc_company?: string | null } };
  actorUserId: string;
  requesterUserId: string | null;
  actorName: string;
  note: string | null;
}): Promise<void> {
  try {
    const receiverIds = await listProposalReceiverUserIds();
    if (receiverIds.length === 0) return;
    const already = new Set([input.actorUserId, input.requesterUserId].filter(Boolean) as string[]);
    const { insertCommercialProposalApprovalDecidedNotification } = await import(
      "@/lib/notifications/commercial-events"
    );
    for (const uid of receiverIds) {
      if (already.has(uid)) continue;
      void insertCommercialProposalApprovalDecidedNotification({
        decision: input.decision,
        proposalId: input.proposal.id,
        revisionNumber: input.proposal.revision_number,
        opportunityId: input.proposal.opportunity_id,
        gcCompany: input.proposal.header_json.gc_company?.trim() ?? null,
        recipientUserId: uid,
        actingUserId: input.actorUserId,
        actorName: input.actorName,
        note: input.note,
        forReceiver: true,
      }).catch((err) => console.warn("[notifyProposalReceivers] one recipient failed:", err));
    }
  } catch (err) {
    console.warn("[notifyProposalReceivers] failed:", err);
  }
}

/** Resolve a user's display name for notification copy (sf_user_name →
 *  email → generic). Mirrors sendProposal's inline lookup. */
async function resolveActorName(userId: string): Promise<string> {
  const sb = commercialDb();
  const { data: prof } = await sb
    .from("profiles")
    .select("sf_user_name, email")
    .eq("user_id", userId)
    .maybeSingle();
  const p = prof as { sf_user_name?: string | null; email?: string | null } | null;
  return p?.sf_user_name || p?.email || "A teammate";
}

/** Small patch helper — writes approval-tracking columns directly (the
 *  status flip goes through updateProposalStatus for cascade + audit).
 *  Mirrors reopenProposal's approved_at clear. Best-effort: a failure to
 *  stamp the metadata doesn't roll back the status flip, but is logged. */
async function patchApprovalFields(
  proposalId: string,
  fields: Record<string, unknown>
): Promise<void> {
  const sb = commercialDb();
  const { error } = await sb
    .from("commercial_proposals")
    .update(fields)
    .eq("id", proposalId);
  if (error) {
    console.warn(
      `[proposals] approval-field patch failed for ${proposalId}: ${error.message}`
    );
  }
}

/** Step 1 — anyone with edit rights asks for approval. draft → pending_approval.
 *  Guards: proposal is a live draft + has ≥1 inclusion (nothing to approve on an
 *  empty bid). Stamps the requester + clears any stale changes-requested note.
 *  Fires the "please approve" bell/email to every approver. */
export async function requestProposalApproval(input: {
  proposal_id: string;
  actor_user_id: string;
  actor_name?: string;
}): Promise<
  | { ok: true; proposal: CommercialProposal }
  | { ok: false; error: string }
> {
  const proposal = await getProposal(input.proposal_id);
  if (!proposal) return { ok: false, error: "Proposal not found." };
  if (proposal.status !== "draft") {
    return {
      ok: false,
      error: `Only a draft can be sent for approval (this one is ${proposalReadableStatus(proposal.status)}).`,
    };
  }
  const lineItems = await listLineItemsForProposal(input.proposal_id);
  if (lineItems.filter((i) => !i.is_alternate).length === 0) {
    return { ok: false, error: "Add at least one inclusion before requesting approval." };
  }

  const flip = await updateProposalStatus({
    id: input.proposal_id,
    to_status: "pending_approval",
    acting_user_id: input.actor_user_id,
  });
  if (!flip.ok) return { ok: false, error: flip.error };

  const nowIso = new Date().toISOString();
  await patchApprovalFields(input.proposal_id, {
    approval_requested_by_user_id: input.actor_user_id,
    approval_requested_at: nowIso,
    // Clear a prior kick-back note so the approver sees a clean request.
    changes_requested_note: null,
    changes_requested_at: null,
  });

  // Notify approvers (fire-and-forget; a bell hiccup never blocks the flip).
  try {
    const actorName = input.actor_name ?? (await resolveActorName(input.actor_user_id));
    const { insertCommercialProposalApprovalRequestedNotifications } =
      await import("@/lib/notifications/commercial-events");
    void insertCommercialProposalApprovalRequestedNotifications({
      proposalId: proposal.id,
      revisionNumber: proposal.revision_number,
      totalCents: flip.proposal.total_cents,
      opportunityId: proposal.opportunity_id,
      gcCompany: proposal.header_json.gc_company?.trim() ?? null,
      actingUserId: input.actor_user_id,
      actorName,
    }).catch((err) => {
      console.warn("[requestProposalApproval] approver fanout failed (async):", err);
    });
  } catch (err) {
    console.warn("[requestProposalApproval] approver fanout failed:", err);
  }

  return { ok: true, proposal: flip.proposal };
}

/** Step 2 — an APPROVER approves. pending_approval → approved. APPROVER-ONLY:
 *  the actor must pass isProposalApprover or this rejects (the hard gate).
 *  Stamps approver + approval timestamp. Notifies the original requester. */
export async function approveProposal(input: {
  proposal_id: string;
  actor_user_id: string;
  actor_name?: string;
}): Promise<
  | { ok: true; proposal: CommercialProposal }
  | { ok: false; error: string }
> {
  if (!(await isProposalApprover(input.actor_user_id))) {
    return {
      ok: false,
      error: "Only a designated approver can approve a proposal. Ask an admin to flag you as an approver in Settings → Access.",
    };
  }
  const proposal = await getProposal(input.proposal_id);
  if (!proposal) return { ok: false, error: "Proposal not found." };
  if (proposal.status !== "pending_approval") {
    return {
      ok: false,
      error: `Only a proposal awaiting approval can be approved (this one is ${proposalReadableStatus(proposal.status)}).`,
    };
  }

  const flip = await updateProposalStatus({
    id: input.proposal_id,
    to_status: "approved",
    acting_user_id: input.actor_user_id,
  });
  if (!flip.ok) return { ok: false, error: flip.error };

  const nowIso = new Date().toISOString();
  await patchApprovalFields(input.proposal_id, {
    approved_by_user_id: input.actor_user_id,
    approval_approved_at: nowIso,
    // An approval clears any prior kick-back note (it's resolved now).
    changes_requested_note: null,
    changes_requested_at: null,
  });

  // Notify the requester (if any, and not the approver themselves).
  if (
    proposal.approval_requested_by_user_id &&
    proposal.approval_requested_by_user_id !== input.actor_user_id
  ) {
    try {
      const actorName = input.actor_name ?? (await resolveActorName(input.actor_user_id));
      const { insertCommercialProposalApprovalDecidedNotification } =
        await import("@/lib/notifications/commercial-events");
      void insertCommercialProposalApprovalDecidedNotification({
        decision: "approved",
        proposalId: proposal.id,
        revisionNumber: proposal.revision_number,
        opportunityId: proposal.opportunity_id,
        gcCompany: proposal.header_json.gc_company?.trim() ?? null,
        recipientUserId: proposal.approval_requested_by_user_id,
        actingUserId: input.actor_user_id,
        actorName,
        note: null,
      }).catch((err) => {
        console.warn("[approveProposal] requester notify failed (async):", err);
      });
    } catch (err) {
      console.warn("[approveProposal] requester notify failed:", err);
    }
  }

  // RUX-6: also ping the receivers (Settings → Access), minus the actor + requester.
  await notifyProposalReceivers({
    decision: "approved",
    proposal,
    actorUserId: input.actor_user_id,
    requesterUserId: proposal.approval_requested_by_user_id,
    actorName: input.actor_name ?? (await resolveActorName(input.actor_user_id)),
    note: null,
  });

  return { ok: true, proposal: flip.proposal };
}

/** Step 2b — an APPROVER kicks it back for edits. pending_approval | approved
 *  → draft, with a reason. APPROVER-ONLY. Clears the approval stamp (approval
 *  is invalidated) + records the changes-requested note. Notifies the requester. */
export async function requestProposalChanges(input: {
  proposal_id: string;
  actor_user_id: string;
  note: string;
  actor_name?: string;
}): Promise<
  | { ok: true; proposal: CommercialProposal }
  | { ok: false; error: string }
> {
  if (!(await isProposalApprover(input.actor_user_id))) {
    return {
      ok: false,
      error: "Only a designated approver can request changes.",
    };
  }
  const note = (input.note ?? "").trim();
  if (!note) return { ok: false, error: "Add a note so the estimator knows what to change." };
  const cappedNote = note.length > 2000 ? note.slice(0, 2000) : note;

  const proposal = await getProposal(input.proposal_id);
  if (!proposal) return { ok: false, error: "Proposal not found." };
  if (proposal.status !== "pending_approval" && proposal.status !== "approved") {
    return {
      ok: false,
      error: `Only a proposal awaiting approval (or already approved) can be sent back (this one is ${proposalReadableStatus(proposal.status)}).`,
    };
  }

  const flip = await updateProposalStatus({
    id: input.proposal_id,
    to_status: "draft",
    acting_user_id: input.actor_user_id,
  });
  if (!flip.ok) return { ok: false, error: flip.error };

  const nowIso = new Date().toISOString();
  await patchApprovalFields(input.proposal_id, {
    changes_requested_note: cappedNote,
    changes_requested_at: nowIso,
    // Approval (if it existed) is invalidated by a kick-back.
    approved_by_user_id: null,
    approval_approved_at: null,
  });

  if (
    proposal.approval_requested_by_user_id &&
    proposal.approval_requested_by_user_id !== input.actor_user_id
  ) {
    try {
      const actorName = input.actor_name ?? (await resolveActorName(input.actor_user_id));
      const { insertCommercialProposalApprovalDecidedNotification } =
        await import("@/lib/notifications/commercial-events");
      void insertCommercialProposalApprovalDecidedNotification({
        decision: "changes_requested",
        proposalId: proposal.id,
        revisionNumber: proposal.revision_number,
        opportunityId: proposal.opportunity_id,
        gcCompany: proposal.header_json.gc_company?.trim() ?? null,
        recipientUserId: proposal.approval_requested_by_user_id,
        actingUserId: input.actor_user_id,
        actorName,
        note: cappedNote,
      }).catch((err) => {
        console.warn("[requestProposalChanges] requester notify failed (async):", err);
      });
    } catch (err) {
      console.warn("[requestProposalChanges] requester notify failed:", err);
    }
  }

  // RUX-6: also ping the receivers (Settings → Access), minus the actor + requester.
  await notifyProposalReceivers({
    decision: "changes_requested",
    proposal,
    actorUserId: input.actor_user_id,
    requesterUserId: proposal.approval_requested_by_user_id,
    actorName: input.actor_name ?? (await resolveActorName(input.actor_user_id)),
    note: cappedNote,
  });

  return { ok: true, proposal: flip.proposal };
}

/** Unlock an already-approved proposal back to draft so it can be edited.
 *  approved → draft. Any editor may do this (it's not an approval action —
 *  it INVALIDATES the approval and forces a fresh approval before send).
 *  No approver check; the re-approval is the gate. */
export async function unlockApprovedProposal(input: {
  proposal_id: string;
  actor_user_id: string;
}): Promise<
  | { ok: true; proposal: CommercialProposal }
  | { ok: false; error: string }
> {
  const proposal = await getProposal(input.proposal_id);
  if (!proposal) return { ok: false, error: "Proposal not found." };
  if (proposal.status !== "approved") {
    return {
      ok: false,
      error: `Only an approved proposal can be unlocked (this one is ${proposalReadableStatus(proposal.status)}).`,
    };
  }

  const flip = await updateProposalStatus({
    id: input.proposal_id,
    to_status: "draft",
    acting_user_id: input.actor_user_id,
  });
  if (!flip.ok) return { ok: false, error: flip.error };

  await patchApprovalFields(input.proposal_id, {
    // Editing invalidates the approval — clear it so the row must be
    // re-approved before it can be sent again.
    approved_by_user_id: null,
    approval_approved_at: null,
    // Also clear the prior request stamp so the next request is clean.
    approval_requested_by_user_id: null,
    approval_requested_at: null,
  });

  return { ok: true, proposal: flip.proposal };
}

/** Withdraw a pending approval request back to draft. Unlike requestChanges
 *  (approver-only, needs a note), ANY editor can withdraw — it's the sender's
 *  "actually, let me change something first" escape hatch. Not a gate bypass:
 *  it lands back in draft and must be re-approved before it can be sent. */
export async function withdrawApprovalRequest(input: {
  proposal_id: string;
  actor_user_id: string;
}): Promise<
  | { ok: true; proposal: CommercialProposal }
  | { ok: false; error: string }
> {
  const proposal = await getProposal(input.proposal_id);
  if (!proposal) return { ok: false, error: "Proposal not found." };
  if (proposal.status !== "pending_approval") {
    return {
      ok: false,
      error: `Only a proposal awaiting approval can be withdrawn (this one is ${proposalReadableStatus(proposal.status)}).`,
    };
  }

  const flip = await updateProposalStatus({
    id: input.proposal_id,
    to_status: "draft",
    acting_user_id: input.actor_user_id,
  });
  if (!flip.ok) return { ok: false, error: flip.error };

  await patchApprovalFields(input.proposal_id, {
    // Clear the request stamp so the next request starts clean. No
    // changes_requested_note — this is a self-withdraw, not a rejection.
    approval_requested_by_user_id: null,
    approval_requested_at: null,
  });

  return { ok: true, proposal: flip.proposal };
}

/** Human label for a proposal status in error strings. */
function proposalReadableStatus(s: string): string {
  const map: Record<string, string> = {
    draft: "a draft",
    pending_approval: "awaiting approval",
    approved: "approved",
    sent: "already sent",
    won: "won",
    lost: "lost",
    expired: "expired",
    superseded: "replaced by a newer revision",
  };
  return map[s] ?? s;
}

/** Karan 2026-07-15: bulk delete every DRAFT proposal under an account
 *  in a single click. Same draft-only guard as softDeleteProposal — we
 *  never nuke a Sent/Won/Lost/Replaced row because those are legal
 *  history. Returns counts + optional skipped-because-not-draft list
 *  so the UI can show "Deleted N drafts. Skipped M non-drafts (they're
 *  historical, bump a new revision instead)." */
export async function bulkDeleteProposalDraftsForAccount(
  accountId: string,
  actorUserId: string | null
): Promise<{
  ok: true;
  deletedCount: number;
  skippedNonDraftCount: number;
} | { ok: false; error: string }> {
  const sb = commercialDb();
  // Pull every non-deleted proposal for this account (via inner join on
  // opportunity → account_id) so we can log + count non-drafts.
  const { data, error } = await sb
    .from("commercial_proposals")
    .select("id, status, opportunity:commercial_opportunities!inner(account_id, deleted_at)")
    .is("deleted_at", null)
    .eq("opportunity.account_id", accountId)
    .is("opportunity.deleted_at", null);
  if (error) return { ok: false, error: error.message };
  type Row = {
    id: string;
    status: string;
    opportunity: { account_id: string; deleted_at: string | null } | null;
  };
  const rows = ((data as unknown as Row[]) ?? []).filter(
    (r) => r.opportunity && !r.opportunity.deleted_at
  );
  const draftIds = rows.filter((r) => r.status === "draft").map((r) => r.id);
  const skipped = rows.length - draftIds.length;
  if (draftIds.length === 0) {
    return { ok: true, deletedCount: 0, skippedNonDraftCount: skipped };
  }
  const now = new Date().toISOString();
  const { error: delError } = await sb
    .from("commercial_proposals")
    .update({ deleted_at: now, updated_by_user_id: actorUserId })
    .in("id", draftIds)
    .eq("status", "draft"); // defense-in-depth against status flip mid-request
  if (delError) return { ok: false, error: delError.message };
  // Best-effort audit log per row (don't fail the whole op if one fails).
  await Promise.all(
    draftIds.map((id) =>
      logDelete("commercial_proposals", id, { id, bulk: true }, actorUserId).catch(
        (e) => console.warn(`[bulkDelete] audit log failed for ${id}:`, e)
      )
    )
  );
  return { ok: true, deletedCount: draftIds.length, skippedNonDraftCount: skipped };
}

// ────────────── reads ──────────────

export async function getProposal(
  id: string
): Promise<CommercialProposal | null> {
  const sb = commercialDb();
  const { data } = await sb
    .from("commercial_proposals")
    .select("*")
    .eq("id", id)
    .is("deleted_at", null)
    .maybeSingle();
  return (data as CommercialProposal | null) ?? null;
}

export async function listProposalsForOpp(
  opportunityId: string
): Promise<CommercialProposal[]> {
  const sb = commercialDb();
  const { data } = await sb
    .from("commercial_proposals")
    .select("*")
    .eq("opportunity_id", opportunityId)
    .is("deleted_at", null)
    .order("revision_number", { ascending: false });
  return (data as CommercialProposal[] | null) ?? [];
}

/**
 * Current proposal total per deal, for a batch of deals.
 *
 * Why this exists: the meeting removed Bid low/high from both create forms
 * (2026-08), because pricing lives on the proposal now. But every pipeline
 * KPI — weighted pipeline, bid range, the stage funnel — derived its number
 * from those two fields, so a brand-new deal contributed ZERO and the
 * dashboard quietly drifted low as the team created deals the new way. The
 * fix is to let those KPIs fall back to what the deal is actually priced at:
 * its live proposal.
 *
 * "Current" = the highest revision that isn't superseded or expired, so a
 * bumped R2 replaces R1 rather than double-counting alongside it. Lost
 * proposals still count while the DEAL is open — losing one bid on a deal
 * you're still pursuing doesn't make the pursuit worth nothing.
 *
 * One query for all deals, mapped in memory. Deals with no proposal are
 * simply absent from the map, and callers treat that as "no fallback".
 */
export async function listCurrentProposalByOpp(
  opportunityIds: string[]
): Promise<Map<string, { status: ProposalStatus; revision: number; totalCents: number }>> {
  const out = new Map<string, { status: ProposalStatus; revision: number; totalCents: number }>();
  const ids = Array.from(new Set(opportunityIds.filter(Boolean)));
  if (ids.length === 0) return out;
  const sb = commercialDb();
  const rows = await paginateAll<{
    opportunity_id: string;
    revision_number: number;
    total_cents: number;
    status: ProposalStatus;
  }>(() =>
    sb
      .from("commercial_proposals")
      .select("opportunity_id, revision_number, total_cents, status")
      .in("opportunity_id", ids)
      .is("deleted_at", null)
      .not("status", "in", "(superseded,expired)")
      // Stable tiebreak so pagination can't interleave rows unpredictably.
      .order("opportunity_id", { ascending: true })
      .order("revision_number", { ascending: false })
  );
  for (const r of rows) {
    // Rows arrive newest-revision-first per deal, so the first one wins.
    if (!out.has(r.opportunity_id)) {
      out.set(r.opportunity_id, {
        status: r.status,
        revision: r.revision_number,
        totalCents: r.total_cents ?? 0,
      });
    }
  }
  return out;
}

/** Just the totals, for callers that don't care about the proposal's state. */
export async function listCurrentProposalTotalByOpp(
  opportunityIds: string[]
): Promise<Map<string, number>> {
  const byOpp = await listCurrentProposalByOpp(opportunityIds);
  return new Map(Array.from(byOpp, ([id, p]) => [id, p.totalCents]));
}

/**
 * The ACCEPTED (won) proposal for a deal + its billable inclusions (non-
 * alternate line items) — the single choke-point the invoice form uses to
 * "pull from the proposal." Mirrors the won-proposal query used by the AIA
 * contract ladder + listProjects (largest total if >1, defensive). Returns
 * null when the deal has no accepted proposal (form falls back to free text).
 */
export async function getAcceptedProposalForOpp(
  opportunityId: string
): Promise<{ proposal: CommercialProposal; inclusions: CommercialProposalLineItem[] } | null> {
  const sb = commercialDb();
  const { data: idRow } = await sb
    .from("commercial_proposals")
    .select("id, total_cents")
    .eq("opportunity_id", opportunityId)
    .eq("status", "won")
    .is("deleted_at", null)
    .order("total_cents", { ascending: false })
    .limit(1)
    .maybeSingle();
  const wonId = (idRow as { id: string } | null)?.id;
  if (!wonId) return null;
  const proposal = await getProposal(wonId);
  if (!proposal) return null;
  const allLines = await listLineItemsForProposal(wonId);
  const inclusions = allLines.filter((l) => !l.is_alternate);
  return { proposal, inclusions };
}

// ────────────── line-item CRUD + rollup ──────────────

export type CreateLineItemInput = {
  proposal_id: string;
  product_id?: string | null;
  /** Migration 071: snapshotted product display name. Empty/undefined for
   *  free-text rows. Trimmed on write; empty → NULL. */
  product_name?: string | null;
  description: string;
  quantity: number;
  unit: string;
  unit_price_cents: number;
  is_alternate?: boolean;
  position?: number;
  /** F.6: optional phase label. Trimmed on write; empty → NULL. */
  phase?: string | null;
  /** Migration 063: labor row flag. Rolls into TOTAL like inclusions but
   *  renders in the "Labor:" PDF section. Cannot be true + is_alternate
   *  simultaneously (rejected at the action layer). */
  is_labor?: boolean;
  /** R1a (migration 100): print this line's price on the client PDF. Default
   *  true. Hidden lines still count toward the total. */
  show_price?: boolean;
};

/** Migration 071 deploy-safety helpers. `product_name` is a brand-new
 *  column; between shipping this code and applying the migration (plus
 *  PostgREST schema-cache lag right after) a write that includes it would
 *  fail. `withProductName` adds it to a payload; `isMissingProductNameColumn`
 *  detects the specific "column doesn't exist yet" error so the caller can
 *  retry once without it. Remove both once 071 is live everywhere. */
function withProductName<T extends object>(
  payload: T,
  name: string | null | undefined
): T & { product_name: string | null } {
  return { ...payload, product_name: name?.trim() || null };
}
function isMissingProductNameColumn(err: { code?: string; message?: string } | null): boolean {
  if (!err) return false;
  // PGRST204 = column not in PostgREST schema cache; 42703 = undefined_column.
  if (err.code === "PGRST204" || err.code === "42703") return true;
  return /product_name/i.test(err.message ?? "");
}

/**
 * Guard: line-item add/edit/delete may only touch a DRAFT proposal (re-audit
 * 2026-07-28). A Sent/Won/Lost/Superseded proposal is the frozen legal record
 * the GC already has — its TOTAL must not change. `updateProposal` already
 * enforces this for proposal-level fields, but the line-item path did not, so a
 * stale form submit (proposal sent in another tab / by a teammate) or a forged
 * POST could silently re-price a sent proposal. Every line-item mutation gates
 * on this now.
 */
async function assertProposalDraft(
  proposalId: string
): Promise<{ ok: true } | { ok: false; error: string }> {
  const sb = commercialDb();
  const { data } = await sb
    .from("commercial_proposals")
    .select("status, deleted_at")
    .eq("id", proposalId)
    .maybeSingle();
  const row = data as { status?: string; deleted_at?: string | null } | null;
  if (!row || row.deleted_at) return { ok: false, error: "Proposal not found." };
  if (row.status !== "draft") {
    return {
      ok: false,
      error: `Only draft proposals can be edited. This one is ${row.status}. Start a new revision to make changes.`,
    };
  }
  return { ok: true };
}

export async function createLineItem(
  input: CreateLineItemInput,
  actorUserId: string | null
): Promise<
  | { ok: true; item: CommercialProposalLineItem }
  | { ok: false; error: string }
> {
  const draftGate = await assertProposalDraft(input.proposal_id);
  if (!draftGate.ok) return draftGate;
  // Migration 071: a row needs EITHER a picked product (product_name) OR
  // a typed description — a catalog product with a blank description is a
  // valid line now that Product + Description are distinct fields. Labor
  // rows have no product picker, so the message is description-only there.
  if (!input.description.trim() && !input.product_name?.trim())
    return {
      ok: false,
      error: input.is_labor
        ? "Type a description for the labor row."
        : "Pick a product or type a description.",
    };
  if (input.quantity < 0)
    return { ok: false, error: "Quantity must be zero or greater." };
  // Round-3 audit fix: qty=0 on inclusions produces a $0 row on the
  // PDF customer sees — semantically odd + likely a typo. Rejected on
  // inclusions, still allowed on alternates (a $0 alternate is a
  // legitimate "no-cost add-on if you sign" pattern).
  if (input.quantity === 0 && !(input.is_alternate ?? false)) {
    return { ok: false, error: "Quantity must be greater than 0 for inclusions." };
  }
  if (input.unit_price_cents < 0)
    return { ok: false, error: "Unit price must be zero or greater." };
  const sb = commercialDb();
  // Auto-assign position at the end of the current list if not supplied.
  let position = input.position ?? -1;
  if (position < 0) {
    const { data: last } = await sb
      .from("commercial_proposal_line_items")
      .select("position")
      .eq("proposal_id", input.proposal_id)
      .eq("is_alternate", input.is_alternate ?? false)
      .order("position", { ascending: false })
      .limit(1);
    position = ((last?.[0] as { position?: number } | undefined)?.position ?? -1) + 1;
  }
  // F.6: normalize phase text — trim, strip newlines + zero-width
  // chars (paste-in poison), empty → NULL, cap at 60 chars so a
  // runaway paste can't blow the PDF header layout.
  const phaseNormalized = (() => {
    let raw = input.phase?.trim() ?? "";
    raw = raw.replace(/[​-‍﻿]/g, "").replace(/[\r\n]+/g, " ").trim();
    if (!raw) return null;
    return raw.length > 60 ? raw.slice(0, 60) : raw;
  })();
  let { data, error } = await sb
    .from("commercial_proposal_line_items")
    .insert(withProductName({
      proposal_id: input.proposal_id,
      product_id: input.product_id ?? null,
      description: input.description.trim(),
      quantity: input.quantity,
      unit: input.unit,
      unit_price_cents: input.unit_price_cents,
      is_alternate: input.is_alternate ?? false,
      position,
      phase: phaseNormalized,
      // Migration 063: labor flag. Cannot coexist with is_alternate.
      is_labor: input.is_labor ?? false,
      // R1a (migration 100): default true. On an un-migrated DB the generic
      // missing-column retry below drops it (defaults to true server-side).
      show_price: input.show_price ?? true,
    }, input.product_name))
    .select("*")
    .single();
  // Migration 071 deploy-safety: if product_name isn't in the schema yet
  // (migration not applied / PostgREST cache lag), retry once without it
  // so line-item creation never breaks on the ordering window.
  if (error && isMissingProductNameColumn(error)) {
    const retry = await sb
      .from("commercial_proposal_line_items")
      .insert({
        proposal_id: input.proposal_id,
        product_id: input.product_id ?? null,
        description: input.description.trim(),
        quantity: input.quantity,
        unit: input.unit,
        unit_price_cents: input.unit_price_cents,
        is_alternate: input.is_alternate ?? false,
        position,
        phase: phaseNormalized,
        is_labor: input.is_labor ?? false,
      })
      .select("*")
      .single();
    data = retry.data;
    error = retry.error;
  }
  if (error) return { ok: false, error: error.message };
  const item = data as CommercialProposalLineItem;
  await logInsert(
    "commercial_proposal_line_items",
    item.id,
    item,
    actorUserId
  );
  await recomputeProposalTotal(input.proposal_id, actorUserId);
  return { ok: true, item };
}

export type UpdateLineItemInput = {
  id: string;
  description?: string;
  /** Migration 071: product display name. Pass empty/null to clear. */
  product_name?: string | null;
  quantity?: number;
  unit?: string;
  unit_price_cents?: number;
  is_alternate?: boolean;
  position?: number;
  /** F.6: phase label. Pass empty string or null to clear. */
  phase?: string | null;
  /** R1a: toggle per-line price visibility on the client PDF. */
  show_price?: boolean;
};

export async function updateLineItem(
  input: UpdateLineItemInput,
  actorUserId: string | null
): Promise<
  | { ok: true; item: CommercialProposalLineItem }
  | { ok: false; error: string }
> {
  const patch: Record<string, unknown> = {};
  if (input.product_name !== undefined) {
    patch.product_name = input.product_name?.trim() || null;
  }
  if (input.description !== undefined) {
    // Migration 071: an empty description is allowed when the row carries a
    // product_name (Product + Description are distinct now). Only reject a
    // fully-blank row (no product being set + no existing product_name).
    const trimmed = input.description.trim();
    if (!trimmed && input.product_name !== undefined && !input.product_name?.trim()) {
      return { ok: false, error: "Pick a product or type a description." };
    }
    patch.description = trimmed;
  }
  if (input.quantity !== undefined) {
    if (input.quantity < 0)
      return { ok: false, error: "Quantity must be zero or greater." };
    // Round-3 audit fix: reject qty=0 on inclusion updates too. Need
    // to know whether the row is an alternate — check is_alternate
    // from the patch if supplied, else re-fetch to be safe.
    const willBeAlternate = input.is_alternate ?? undefined;
    if (input.quantity === 0) {
      if (willBeAlternate === false) {
        return { ok: false, error: "Quantity must be greater than 0 for inclusions." };
      }
      if (willBeAlternate === undefined) {
        // Fetch existing to know the row's current is_alternate.
        const { data: existing } = await commercialDb()
          .from("commercial_proposal_line_items")
          .select("is_alternate")
          .eq("id", input.id)
          .maybeSingle();
        if (existing && !(existing as { is_alternate: boolean }).is_alternate) {
          return { ok: false, error: "Quantity must be greater than 0 for inclusions." };
        }
      }
    }
    patch.quantity = input.quantity;
  }
  if (input.unit !== undefined) patch.unit = input.unit;
  if (input.unit_price_cents !== undefined) {
    if (input.unit_price_cents < 0)
      return { ok: false, error: "Unit price must be zero or greater." };
    patch.unit_price_cents = input.unit_price_cents;
  }
  if (input.is_alternate !== undefined) patch.is_alternate = input.is_alternate;
  if (input.show_price !== undefined) patch.show_price = input.show_price;
  if (input.position !== undefined) patch.position = input.position;
  if (input.phase !== undefined) {
    // F.6 audit fix: strip newlines + zero-width chars so a paste-in
    // with control chars can't blow up the PDF header. Cap at 60 chars.
    let raw = input.phase?.trim() ?? "";
    raw = raw.replace(/[​-‍﻿]/g, "").replace(/[\r\n]+/g, " ");
    raw = raw.trim();
    patch.phase = raw ? (raw.length > 60 ? raw.slice(0, 60) : raw) : null;
  }
  const sb = commercialDb();
  const { data: before } = await sb
    .from("commercial_proposal_line_items")
    .select("*")
    .eq("id", input.id)
    .maybeSingle();
  if (!before) return { ok: false, error: "Line item not found." };
  // Only editable while the parent proposal is a draft.
  const draftGate = await assertProposalDraft((before as CommercialProposalLineItem).proposal_id);
  if (!draftGate.ok) return draftGate;
  let { data: after, error } = await sb
    .from("commercial_proposal_line_items")
    .update(patch)
    .eq("id", input.id)
    .select("*")
    .single();
  // Migration 071 deploy-safety: retry without product_name if the column
  // isn't in the schema yet (see createLineItem).
  if (error && isMissingProductNameColumn(error) && "product_name" in patch) {
    const { product_name: _drop, ...rest } = patch;
    const retry = await sb
      .from("commercial_proposal_line_items")
      .update(rest)
      .eq("id", input.id)
      .select("*")
      .single();
    after = retry.data;
    error = retry.error;
  }
  if (error) return { ok: false, error: error.message };
  const item = after as CommercialProposalLineItem;
  await logUpdate(
    "commercial_proposal_line_items",
    item.id,
    before,
    item,
    actorUserId
  );
  await recomputeProposalTotal(item.proposal_id, actorUserId);
  return { ok: true, item };
}

export async function deleteLineItem(
  id: string,
  actorUserId: string | null
): Promise<{ ok: true } | { ok: false; error: string }> {
  const sb = commercialDb();
  const { data: before } = await sb
    .from("commercial_proposal_line_items")
    .select("*")
    .eq("id", id)
    .maybeSingle();
  if (!before) return { ok: false, error: "Line item not found." };
  // Only deletable while the parent proposal is a draft.
  const draftGate = await assertProposalDraft((before as CommercialProposalLineItem).proposal_id);
  if (!draftGate.ok) return draftGate;
  const { error } = await sb
    .from("commercial_proposal_line_items")
    .delete()
    .eq("id", id);
  if (error) return { ok: false, error: error.message };
  await logDelete(
    "commercial_proposal_line_items",
    id,
    before,
    actorUserId
  );
  await recomputeProposalTotal(
    (before as CommercialProposalLineItem).proposal_id,
    actorUserId
  );
  return { ok: true };
}

export async function listLineItemsForProposal(
  proposalId: string
): Promise<CommercialProposalLineItem[]> {
  const sb = commercialDb();
  // F.1 post-audit fix: soft-delete on the parent proposal shouldn't
  // leak orphaned line items. Verify the parent is still visible
  // before returning rows. Cheap: single-row .maybeSingle() then a
  // guarded fetch.
  const { data: parent } = await sb
    .from("commercial_proposals")
    .select("id")
    .eq("id", proposalId)
    .is("deleted_at", null)
    .maybeSingle();
  if (!parent) return [];
  const { data } = await sb
    .from("commercial_proposal_line_items")
    .select("*")
    .eq("proposal_id", proposalId)
    .order("is_alternate", { ascending: true })
    .order("position", { ascending: true });
  return (data as CommercialProposalLineItem[] | null) ?? [];
}

/** Single-item read helper — F.2 editor uses this for inline row
 *  edits ("save this row"). Returns null if the row is missing OR
 *  its parent proposal is soft-deleted. */
export async function getLineItem(
  id: string
): Promise<CommercialProposalLineItem | null> {
  const sb = commercialDb();
  const { data } = await sb
    .from("commercial_proposal_line_items")
    .select("*")
    .eq("id", id)
    .maybeSingle();
  if (!data) return null;
  const row = data as CommercialProposalLineItem;
  const { data: parent } = await sb
    .from("commercial_proposals")
    .select("id")
    .eq("id", row.proposal_id)
    .is("deleted_at", null)
    .maybeSingle();
  if (!parent) return null;
  return row;
}

/** The raw line-item sum (non-alternate rows, qty × unit_price). This is the
 *  number BEFORE any final-price override — used for the internal "override vs
 *  line items" delta. Hidden-price rows (show_price=false) still count. */
export async function proposalLineItemSumCents(proposalId: string): Promise<number> {
  const sb = commercialDb();
  const { data: items } = await sb
    .from("commercial_proposal_line_items")
    .select("quantity, unit_price_cents, is_alternate")
    .eq("proposal_id", proposalId);
  const rows = (items as Array<{ quantity: number; unit_price_cents: number; is_alternate: boolean }> | null) ?? [];
  return rows.reduce((acc, r) => (r.is_alternate ? acc : acc + Math.round(Number(r.quantity) * Number(r.unit_price_cents))), 0);
}

/** Recompute `commercial_proposals.total_cents` = the FINAL PRICE OVERRIDE when
 *  set (R1b), else the non-alternate line-item sum. total_cents is the single
 *  contract number the AIA ladder + invoicing + KPIs consume, so the override
 *  MUST land here or those surfaces diverge (2026-08 money-audit #2). Called
 *  after any line-item mutation AND after the override is set/cleared. */
export async function recomputeProposalTotal(
  proposalId: string,
  actorUserId: string | null
): Promise<void> {
  const sb = commercialDb();
  const [rawSum, { data: prop }] = await Promise.all([
    proposalLineItemSumCents(proposalId),
    sb
      .from("commercial_proposals")
      .select("final_price_override_cents")
      .eq("id", proposalId)
      .maybeSingle(),
  ]);
  const override = (prop as { final_price_override_cents: number | null } | null)?.final_price_override_cents ?? null;
  const total = override != null ? Number(override) : rawSum;
  await sb
    .from("commercial_proposals")
    .update({
      total_cents: total,
      updated_by_user_id: actorUserId,
    })
    .eq("id", proposalId);
}

// ────────────── Phase F.4: Send flow ──────────────

/** Result envelope for sendProposal. */
export type SendProposalResult =
  | { ok: true; proposal: CommercialProposal; snapshot_document_id: string | null }
  | { ok: false; error: string };

/** Send a proposal — the one-click "PDF this and mark it out the door"
 *  moment Alex cares about. Only callable when status='draft' and the
 *  proposal has at least one inclusion line item.
 *
 *  Side effects, all wrapped in the same call so callers never have to
 *  compose them:
 *    1. Render current PDF → upload to Storage under the parent opp's
 *       Documents (category='proposal', favorited).
 *    2. Update proposal: status='sent', sent_at=now(), snapshot_document_id.
 *    3. Flip parent opp status → (proposal, sent) IF it isn't already
 *       past that lane. Only advances forward; won/lost/pre_construction
 *       don't get walked back.
 *    4. Post a system account note ("Proposal R2 sent to WestWood
 *       Contracting.") so the account timeline shows the moment.
 *    5. Fire the commercial_proposal_sent bell → team fanout.
 *
 *  Failures at step 1 (PDF render/upload) abort the whole flow so the
 *  DB doesn't end up marking a proposal 'sent' with no PDF to show for
 *  it. Failures at steps 3-5 are logged but non-fatal — the proposal is
 *  still recorded as sent (source of truth) and the follow-up bell / opp
 *  flip / note can be re-fired by admin if needed.
 */
export async function sendProposal(input: {
  proposal_id: string;
  actor_user_id: string;
  /** Optional — falls back to a profiles lookup if not passed. */
  actor_name?: string;
}): Promise<SendProposalResult> {
  const sb = commercialDb();

  // Resolve actor display name from profiles when not supplied.
  let actorName = input.actor_name ?? "";
  if (!actorName) {
    const { data: prof } = await sb
      .from("profiles")
      .select("sf_user_name, email")
      .eq("user_id", input.actor_user_id)
      .maybeSingle();
    const p = prof as { sf_user_name?: string | null; email?: string | null } | null;
    actorName = p?.sf_user_name || p?.email || "PPP admin";
  }

  // Freshly re-read the proposal + do all the pre-flight checks here so
  // there's a single choke-point.
  const proposal = await getProposal(input.proposal_id);
  if (!proposal) return { ok: false, error: "Proposal not found." };
  // HARD GATE (R1d, Karan 2026-08): a proposal must be APPROVED before it can
  // be sent. draft/pending_approval can no longer send — they route through
  // the approval flow first.
  if (proposal.status !== "approved") {
    return {
      ok: false,
      error:
        proposal.status === "pending_approval"
          ? "This proposal is awaiting approval. An approver must approve it before it can be sent."
          : proposal.status === "draft"
          ? "Send for approval first — a proposal must be approved before it goes out."
          : "Only an approved proposal can be sent.",
    };
  }
  const lineItems = await listLineItemsForProposal(input.proposal_id);
  const inclusionCount = lineItems.filter((i) => !i.is_alternate).length;
  if (inclusionCount === 0) {
    return { ok: false, error: "Add at least one inclusion before sending." };
  }

  // Verify parent opp still exists + not soft-deleted (mirrors the same
  // guard the PDF route uses).
  const { data: oppRow } = await sb
    .from("commercial_opportunities")
    .select("id, account_id, title, status, sub_status")
    .eq("id", proposal.opportunity_id)
    .is("deleted_at", null)
    .maybeSingle();
  const opp = oppRow as {
    id: string;
    account_id: string;
    title: string;
    status: string;
    sub_status: string | null;
  } | null;
  if (!opp) return { ok: false, error: "Parent opportunity not found." };

  // Post-round-2 audit: verify parent account isn't soft-deleted either.
  // The opp check alone lets a "ghosted account" scenario slip through
  // (opp still live but account was archived) — Send would post a note
  // + bell to an account timeline no one can visit.
  const { data: acctCheck } = await sb
    .from("commercial_accounts")
    .select("id")
    .eq("id", opp.account_id)
    .is("deleted_at", null)
    .maybeSingle();
  if (!acctCheck) {
    return { ok: false, error: "Customer for this deal is no longer active." };
  }

  // ── 1. Render PDF + snapshot into Documents ─────────────────────
  // Resolve exclusion texts in the order Alex saved them so the PDF
  // matches what the customer PDF button rendered. Merges library
  // exclusion_ids (ordered) with per-proposal custom_exclusions
  // (this-proposal-only text, ordered as added).
  const { listExclusions } = await import("@/lib/commercial/exclusions/db");
  const allEx = await listExclusions({ activeOnly: false });
  const byId = new Map(allEx.map((e) => [e.id, e.text] as const));
  const libraryTexts = proposal.exclusion_ids
    .map((id) => byId.get(id))
    .filter((t): t is string => Boolean(t && t.trim()));
  // Round-3 audit fix: cap custom exclusion text at 500 chars on the
  // render path so a direct DB write can't blow the PDF layout.
  const customTexts = (proposal.custom_exclusions ?? [])
    .filter((t) => t && t.trim())
    .map((t) => (t.length > 500 ? t.slice(0, 500) + "…" : t));
  const exclusionTexts = [...libraryTexts, ...customTexts];

  const { renderProposalPdf } = await import("./pdf");
  let pdfBuffer: Buffer;
  try {
    pdfBuffer = await renderProposalPdf({
      proposal,
      lineItems,
      exclusions: exclusionTexts,
      mode: "customer",
    });
  } catch (err) {
    console.error("[sendProposal] pdf render failed:", err);
    return { ok: false, error: "PDF render failed. Try Preview PDF first to see the error." };
  }

  const { uploadDocument } = await import("@/lib/commercial/documents/db");
  const gc = (proposal.header_json.gc_company ?? "Proposal").replace(/[^A-Za-z0-9._-]+/g, "_");
  const project = (proposal.header_json.project_name ?? "").replace(/[^A-Za-z0-9._-]+/g, "_");
  const filename = [gc, project, `R${proposal.revision_number}`]
    .filter(Boolean)
    .join("_") + ".pdf";

  const uploaded = await uploadDocument({
    parent_type: "opportunity",
    parent_id: proposal.opportunity_id,
    category: "proposal",
    file_name: filename,
    size_bytes: pdfBuffer.length,
    mime_type: "application/pdf",
    notes: `Proposal R${proposal.revision_number} snapshot — sent ${new Date().toLocaleDateString("en-US", { timeZone: "America/New_York" })}`,
    data: new Uint8Array(pdfBuffer),
    uploaded_by_user_id: input.actor_user_id,
  });
  if (!uploaded.ok) {
    return { ok: false, error: `Snapshot upload failed: ${uploaded.error}` };
  }
  const snapshotDocId = uploaded.document.id;

  // Favorite the snapshot so it's pinned at the top of the Files tab.
  const { favoriteDocument } = await import("@/lib/commercial/documents/db");
  await favoriteDocument(snapshotDocId, input.actor_user_id).catch((err) => {
    console.warn("[sendProposal] favorite snapshot failed:", err);
  });

  // ── 2. Update proposal state (status + sent_at + snapshot ref) ──
  const { data: before } = await sb
    .from("commercial_proposals")
    .select("*")
    .eq("id", input.proposal_id)
    .maybeSingle();
  const nowIso = new Date().toISOString();
  // Post-audit race guard: also filter on status='approved' so two tabs
  // racing on Send can't both overwrite each other's snapshot_document_id.
  // If a concurrent tab already flipped it to 'sent', this UPDATE returns
  // zero rows → maybeSingle returns null → we short-circuit with a
  // friendly error instead of the .single() PGRST116 crash.
  const { data: after, error: updErr } = await sb
    .from("commercial_proposals")
    .update({
      status: "sent" as ProposalStatus,
      sent_at: nowIso,
      snapshot_document_id: snapshotDocId,
      updated_by_user_id: input.actor_user_id,
    })
    .eq("id", input.proposal_id)
    .eq("status", "approved")
    // Post-round-2 audit: also guard on deleted_at so a soft-delete
    // race between the pre-flight fetch and this UPDATE surfaces as a
    // 0-row result instead of writing to a soft-deleted row.
    .is("deleted_at", null)
    .select("*")
    .maybeSingle();
  if (updErr) {
    return { ok: false, error: `State update failed: ${updErr.message}` };
  }
  if (!after) {
    // The row exists but status !== 'draft' at UPDATE time — a concurrent
    // Send won the race. The PDF we uploaded above is orphaned; log for
    // admin cleanup.
    console.warn(
      `[sendProposal] concurrent send won the race for ${input.proposal_id}; orphaned snapshot doc ${snapshotDocId}`
    );
    return { ok: false, error: "This proposal was just sent from another tab. Reload to see the latest state." };
  }
  const sentProposal = after as CommercialProposal;
  await logUpdate(
    "commercial_proposals",
    sentProposal.id,
    before,
    sentProposal,
    input.actor_user_id
  );

  // ── 3. Flip opp status → (proposal, sent) if not past that lane ─
  // Karan 2026-07-16: v2 status names. Prior set had v1 legacy names
  // (won/lost/wip/post_construction) that never match v2 — result was
  // that sending a proposal on a Won/InProgress/Billing deal walked
  // the deal backward to Proposal Sent, wiping real state.
  //
  // v2 statuses "past" Proposal Sent: pre_sale_closed (Won/Lost),
  // pre_construction, in_progress, billing, post_sale_closed. Any of
  // these means the bid has been decided and delivery is (or was)
  // underway — sending a proposal shouldn't rewind the deal.
  // The hand-maintained "don't rewind past these" list this used to carry is
  // now the engine's forward-only rule, which also covers what the list missed
  // — a deal already at Proposal · Follow-Up is ahead of Sent within the same
  // stage, and the list had no way to say so.
  const { autoAdvanceOpportunity } = await import(
    "@/lib/commercial/opportunities/auto-advance"
  );
  const sendRes = await autoAdvanceOpportunity({
    oppId: opp.id,
    target: "proposal",
    artifactAt: new Date().toISOString(),
    source: "auto_advance",
    reason: `Proposal R${sentProposal.revision_number} sent`,
    actingUserId: input.actor_user_id,
  });
  if (!sendRes.moved && sendRes.reason === "error") {
    console.warn(
      `[sendProposal] opp status flip failed for opp ${opp.id}: ${sendRes.detail}`
    );
  }

  // ── 4. Account timeline note ────────────────────────────────────
  const gcLabel = proposal.header_json.gc_company?.trim();
  const noteBody = gcLabel
    ? `Proposal R${sentProposal.revision_number} sent to ${gcLabel}.`
    : `Proposal R${sentProposal.revision_number} sent.`;
  try {
    const { addAccountNote } = await import("@/lib/commercial/account-notes");
    await addAccountNote({
      account_id: opp.account_id,
      body: noteBody,
      // Post-audit fix: this is a system-posted note, not user-typed.
      // 'auto_debrief' is the existing "system generated" kind so the
      // timeline UI renders the slate-badge variant + the source-opp
      // link instead of treating it as a human-authored note.
      kind: "auto_debrief",
      source_opportunity_id: opp.id,
      author_user_id: input.actor_user_id,
    });
  } catch (err) {
    console.warn("[sendProposal] account note failed:", err);
  }

  // ── 5. Bump use_count on each picked library exclusion ──────────
  // Post-round-2 audit: sendProposal was firing everything except this,
  // so the picker's "most-used" sort never learned which exclusions
  // Alex actually ships. Fire-and-forget with a warn log — a use_count
  // hiccup should never block Send.
  if (proposal.exclusion_ids.length > 0) {
    try {
      const { bumpExclusionUseCount } = await import(
        "@/lib/commercial/exclusions/db"
      );
      void bumpExclusionUseCount(proposal.exclusion_ids).catch((err) => {
        console.warn("[sendProposal] use_count bump failed (async):", err);
      });
    } catch (err) {
      console.warn("[sendProposal] use_count bump failed:", err);
    }
  }

  // ── 6. Bell + email fanout to opp team ──────────────────────────
  try {
    const { insertCommercialProposalSentNotifications } = await import(
      "@/lib/notifications/commercial-events"
    );
    // Post-round-2 audit: chain .catch() on the void promise so an
    // unhandled rejection inside the fanout doesn't crash the Node
    // process (fire-and-forget still, just observable).
    void insertCommercialProposalSentNotifications({
      proposalId: sentProposal.id,
      revisionNumber: sentProposal.revision_number,
      totalCents: sentProposal.total_cents,
      opportunityId: opp.id,
      accountId: opp.account_id,
      dealId: opp.id,
      oppTitle: opp.title,
      gcCompany: gcLabel ?? null,
      actingUserId: input.actor_user_id,
      actorName,
    }).catch((err) => {
      console.warn("[sendProposal] bell fanout failed (async):", err);
    });
  } catch (err) {
    console.warn("[sendProposal] bell fanout failed:", err);
  }

  return { ok: true, proposal: sentProposal, snapshot_document_id: snapshotDocId };
}

/** Karan 2026-07-15: self-heal any proposal↔deal state drift.
 *
 *  Problem: the proposal→opp cascade (added earlier today) only fires
 *  on NEW state changes. Existing rows that were misaligned when the
 *  cascade shipped stay drifted until someone manually re-flips them.
 *  Karan hit this: R4 was already Sent, but the parent Test deal was
 *  stuck at estimating.proposal_pending_approval ("Proposal Drafted"
 *  column) — the two surfaces didn't match.
 *
 *  This helper scans every non-terminal proposal + its parent deal,
 *  computes the derived deal tuple from the highest-priority proposal
 *  state on that deal (won > sent > pending_approval > draft > lost),
 *  and fixes any mismatched deals in one pass.
 *
 *  Idempotent + cheap — one SELECT + one UPDATE per drifted deal.
 *  Called from the /commercial/proposals page load so drift heals as
 *  soon as the user visits the surface.
 *
 *  Guardrails:
 *   - Never touches a deal already in delivery (pre_construction /
 *     in_progress / billing / post_sale_closed) — crews might be on
 *     site, don't yank the pipeline backward.
 *   - Never overwrites Won with Lost or vice versa — those are user-
 *     intent decisions that a reconcile shouldn't second-guess.
 */
/**
 * WHEN this proposal reached its current stage — the clock the auto-advance
 * engine weighs against a person's decision.
 *
 * Deliberately NOT `updated_at`. A BEFORE UPDATE trigger bumps that on every
 * write to the row, and re-pricing a line item rewrites the proposal to
 * recompute its total — so changing a quantity moved the timestamp to "now" and
 * re-armed the engine against a deliberate human move. Changing a price is not
 * evidence about which stage a deal is in.
 *
 * Falls back to `updated_at` for statuses with no transition column of their
 * own (`won`/`lost` are recorded on the deal, not here), which is still the
 * best available answer for them.
 */
function proposalStageAt(p: {
  status: string;
  updated_at: string;
  sent_at: string | null;
  approved_at: string | null;
  created_at: string;
}): string {
  switch (p.status) {
    case "draft":
      return p.created_at;
    case "pending_approval":
    case "approved":
      return p.approved_at ?? p.updated_at;
    case "sent":
      return p.sent_at ?? p.updated_at;
    default:
      return p.updated_at;
  }
}

export async function reconcileDealStatesFromProposals(): Promise<{
  checked: number;
  fixed: number;
}> {
  const sb = commercialDb();
  // Karan 2026-07-16: fetch revision_number too so we can align by
  // CURRENT (highest revision) per deal — matches Option A cascade
  // semantics. Prior version picked "highest priority" state across
  // all revisions, which meant a stale R1 Sent could dominate over a
  // fresh R2 Draft and yank the deal back to Proposal · Sent — user
  // symptom: "I moved one card and a different card moved."
  const { data: propRows } = await sb
    .from("commercial_proposals")
    .select("id, status, opportunity_id, revision_number, updated_at, sent_at, approved_at, created_at")
    .is("deleted_at", null)
    .in("status", ["draft", "pending_approval", "approved", "sent", "won", "lost"])
    .order("revision_number", { ascending: false });
  const proposals =
    (propRows as {
      id: string;
      status: string;
      opportunity_id: string;
      revision_number: number;
      updated_at: string;
      sent_at: string | null;
      approved_at: string | null;
      created_at: string;
    }[] | null) ?? [];
  if (proposals.length === 0) return { checked: 0, fixed: 0 };

  // Group proposals by deal, pick the CURRENT (highest revision_number)
  // one — the same "current" the kanban renders. Order was DESC on
  // revision_number so first-write wins.
  // Carries `updated_at` as well as the status: the auto-advance engine
  // compares it against the last human status change to decide who is more
  // current, so a person who deliberately moved a deal isn't overruled by a
  // proposal they'd already seen.
  const currentByDeal = new Map<string, { status: string; stageAt: string }>();
  for (const p of proposals) {
    if (!currentByDeal.has(p.opportunity_id)) {
      currentByDeal.set(p.opportunity_id, { status: p.status, stageAt: proposalStageAt(p) });
    }
  }
  const bestByDeal = currentByDeal;

  // Fetch each affected deal's current state so we only UPDATE where
  // there's actual drift.
  const dealIds = Array.from(bestByDeal.keys());
  const { data: dealRows } = await sb
    .from("commercial_opportunities")
    .select("id, status, sub_status, deleted_at")
    .in("id", dealIds)
    .is("deleted_at", null);
  const deals =
    (dealRows as {
      id: string;
      status: string;
      sub_status: string | null;
    }[] | null) ?? [];

  const postSaleStatuses = new Set([
    "pre_construction",
    "in_progress",
    "billing",
    "post_sale_closed",
  ]);

  const derive = (propStatus: string): { status: string; sub: string } | null => {
    switch (propStatus) {
      // Karan 2026-07-16: distinct draft vs pending_approval mapping
      // (was: both → proposal_pending_approval, which forced deals to
      // show "Proposal Drafted" even when the proposal was still being
      // built). Draft = plain Estimating; Pending Approval = the
      // priced-and-awaiting-sign-off "Proposal Drafted" state.
      case "draft":
        return { status: "estimating", sub: "estimating" };
      case "pending_approval":
        return { status: "estimating", sub: "proposal_pending_approval" };
      case "approved":
        // R1d: internally approved but not yet sent — still Estimating (no
        // customer has seen it). Deal only advances to Proposal · Sent on Send.
        return { status: "estimating", sub: "proposal_pending_approval" };
      case "sent":
        return { status: "proposal", sub: "sent" };
      case "won":
        return { status: "pre_sale_closed", sub: "won" };
      case "lost":
        return { status: "pre_sale_closed", sub: "lost" };
      default:
        return null;
    }
  };

  // Karan 2026-07-16 (round 3): BIDIRECTIONAL reconcile. Forward-only
  // was preventing drift-healing when the deal was ahead of the current
  // proposal — e.g. deal at Proposal Sent (from a prior send) but the
  // user bumped a new Draft revision, current is now Draft. Forward-
  // only kept the deal at Proposal Sent while the proposal card lived
  // in the Draft column: exactly the "cascade only works 70% of the
  // time" pain Karan flagged.
  //
  // Guards still in place:
  //   - Post-sale skip (pre_con / in_prog / billing / post_sale_closed
  //     deals are never touched — crews are on-site, don't yank
  //     backward).
  //   - Won ↔ Lost cross-flip guard — reconcile refuses to auto-flip
  //     between Won and Lost (user-intent decisions).
  //   - `_skipProposalCascade: true` on the deal update — reconcile is
  //     a one-way heal, never fans back out to proposals.
  let fixed = 0;
  for (const deal of deals) {
    if (postSaleStatuses.has(deal.status)) continue;
    const bestProp = bestByDeal.get(deal.id);
    if (!bestProp) continue;
    const target = derive(bestProp.status);
    if (!target) continue;
    // Not just an exact tuple match — RFP-with-a-draft and
    // Follow-Up-with-a-sent are consistent too. This healer runs on every
    // render of the pipeline and the proposals board, so treating either
    // as drift meant the user could never keep a deal in the Request for
    // Proposal column or hold the Follow-Up tag for longer than one page
    // load.
    if (
      dealAlreadyConsistentWithProposal(
        { status: deal.status, sub_status: deal.sub_status },
        target
      )
    ) {
      continue;
    }
    if (deal.status === "pre_sale_closed" && target.status === "pre_sale_closed") {
      continue; // don't cross-flip won ↔ lost via auto-reconcile
    }
    // Karan 2026-07-16 (audit fix): if deal is already Won/Lost, do NOT
    // auto-un-close it via reconcile. The user explicitly closed the
    // deal; a drift-heal that silently rewinds Won → Proposal Sent
    // would erase real intent. If the proposal state disagrees, the
    // user needs to reopen manually (drag Won proposal back to Sent
    // via kanban, which fires reopenProposal end-to-end).
    if (deal.status === "pre_sale_closed" && target.status !== "pre_sale_closed") {
      continue;
    }
    // FORWARD-ONLY, as of the auto-advance engine. This pass used to move a
    // deal in either direction, which is what produced the ping-pong: a deal at
    // Proposal with a fresh R2 draft got yanked back to Estimating on every
    // render of the pipeline or proposals page — by whoever happened to load
    // it — and each swing emailed the whole team. Healing DOWN is now a human
    // decision; the engine only ever moves a deal that is genuinely behind.
    const { autoAdvanceOpportunity } = await import(
      "@/lib/commercial/opportunities/auto-advance"
    );
    const { targetForProposalStatus } = await import(
      "@/lib/commercial/opportunities/auto-advance-targets"
    );
    const key = targetForProposalStatus(bestProp.status);
    if (!key) continue;
    const res = await autoAdvanceOpportunity({
      oppId: deal.id,
      target: key,
      artifactAt: bestProp.stageAt,
      source: "reconcile",
      reason: `Kept in step with proposal (${bestProp.status.replace(/_/g, " ")})`,
    });
    if (res.moved) {
      fixed += 1;
    } else if (res.reason === "error") {
      console.warn(
        `[reconcileDealStatesFromProposals] deal ${deal.id} flip failed: ${res.detail}`
      );
    }
  }
  return { checked: deals.length, fixed };
}
