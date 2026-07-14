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
import type { ProposalStatus } from "./constants";

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
  total_cents: number;
  pdf_show_line_prices: boolean;
  estimator_snapshot_json: ProposalEstimatorSnapshot;
  status: ProposalStatus;
  sent_at: string | null;
  approved_at: string | null;
  expired_at: string | null;
  snapshot_document_id: string | null;
  created_at: string;
  updated_at: string;
  created_by_user_id: string | null;
  updated_by_user_id: string | null;
  deleted_at: string | null;
};

export type CommercialProposalLineItem = {
  id: string;
  proposal_id: string;
  product_id: string | null;
  description: string;
  quantity: number;
  unit: string;
  unit_price_cents: number;
  is_alternate: boolean;
  position: number;
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
  pdf_show_line_prices?: boolean;
  estimator_snapshot_json?: ProposalEstimatorSnapshot;
  parent_proposal_id?: string | null;
  created_by_user_id?: string | null;
};

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
  pdf_show_line_prices?: boolean;
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
  if (input.pdf_show_line_prices !== undefined)
    patch.pdf_show_line_prices = input.pdf_show_line_prices;
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
    input.updated_by_user_id ?? null
  );
  return { ok: true, proposal };
}

export async function updateProposalStatus(input: {
  id: string;
  to_status: ProposalStatus;
  acting_user_id: string | null;
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
  const { error } = await sb
    .from("commercial_proposals")
    .update({
      deleted_at: new Date().toISOString(),
      updated_by_user_id: actorUserId,
    })
    .eq("id", id);
  if (error) return { ok: false, error: error.message };
  await logDelete("commercial_proposals", id, before, actorUserId);
  return { ok: true };
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

// ────────────── line-item CRUD + rollup ──────────────

export type CreateLineItemInput = {
  proposal_id: string;
  product_id?: string | null;
  description: string;
  quantity: number;
  unit: string;
  unit_price_cents: number;
  is_alternate?: boolean;
  position?: number;
};

export async function createLineItem(
  input: CreateLineItemInput,
  actorUserId: string | null
): Promise<
  | { ok: true; item: CommercialProposalLineItem }
  | { ok: false; error: string }
> {
  if (!input.description.trim())
    return { ok: false, error: "Description is required." };
  if (input.quantity < 0)
    return { ok: false, error: "Quantity must be zero or greater." };
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
  const { data, error } = await sb
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
    })
    .select("*")
    .single();
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
  quantity?: number;
  unit?: string;
  unit_price_cents?: number;
  is_alternate?: boolean;
  position?: number;
};

export async function updateLineItem(
  input: UpdateLineItemInput,
  actorUserId: string | null
): Promise<
  | { ok: true; item: CommercialProposalLineItem }
  | { ok: false; error: string }
> {
  const patch: Record<string, unknown> = {};
  if (input.description !== undefined) {
    const trimmed = input.description.trim();
    if (!trimmed) return { ok: false, error: "Description is required." };
    patch.description = trimmed;
  }
  if (input.quantity !== undefined) {
    if (input.quantity < 0)
      return { ok: false, error: "Quantity must be zero or greater." };
    patch.quantity = input.quantity;
  }
  if (input.unit !== undefined) patch.unit = input.unit;
  if (input.unit_price_cents !== undefined) {
    if (input.unit_price_cents < 0)
      return { ok: false, error: "Unit price must be zero or greater." };
    patch.unit_price_cents = input.unit_price_cents;
  }
  if (input.is_alternate !== undefined) patch.is_alternate = input.is_alternate;
  if (input.position !== undefined) patch.position = input.position;
  const sb = commercialDb();
  const { data: before } = await sb
    .from("commercial_proposal_line_items")
    .select("*")
    .eq("id", input.id)
    .maybeSingle();
  if (!before) return { ok: false, error: "Line item not found." };
  const { data: after, error } = await sb
    .from("commercial_proposal_line_items")
    .update(patch)
    .eq("id", input.id)
    .select("*")
    .single();
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

/** Sum non-alternate line items (quantity × unit_price_cents) and
 *  write the result to `commercial_proposals.total_cents`. Called
 *  after any line-item mutation. No-op on missing proposal. */
export async function recomputeProposalTotal(
  proposalId: string,
  actorUserId: string | null
): Promise<void> {
  const sb = commercialDb();
  const { data: items } = await sb
    .from("commercial_proposal_line_items")
    .select("quantity, unit_price_cents, is_alternate")
    .eq("proposal_id", proposalId);
  const rows = (items as Array<{
    quantity: number;
    unit_price_cents: number;
    is_alternate: boolean;
  }> | null) ?? [];
  const total = rows.reduce((acc, r) => {
    if (r.is_alternate) return acc;
    // Cents math via Math.round to avoid float drift on fractional
    // quantities (e.g. 3.5 gallons × $4623).
    return acc + Math.round(Number(r.quantity) * Number(r.unit_price_cents));
  }, 0);
  await sb
    .from("commercial_proposals")
    .update({
      total_cents: total,
      updated_by_user_id: actorUserId,
    })
    .eq("id", proposalId);
}
