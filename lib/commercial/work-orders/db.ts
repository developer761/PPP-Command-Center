import "server-only";

import { commercialDb } from "@/lib/commercial/db";
import { logInsert, logUpdate } from "@/lib/commercial/audit-log";
import {
  ALLOWED_WORK_ORDER_TRANSITIONS,
  type WorkOrderStatus,
} from "./constants";

type Result<T> = { ok: true; value: T } | { ok: false; error: string };

export type WorkOrder = {
  id: string;
  opportunity_id: string;
  account_id: string;
  status: WorkOrderStatus;
  work_notes: string | null;
  assigned_to: string | null;
  crew_email: string | null;
  scheduled_start_date: string | null;
  scheduled_end_date: string | null;
  sent_at: string | null;
  crew_emailed_at: string | null;
  voided_at: string | null;
  snapshot_document_id: string | null;
  created_at: string;
  updated_at: string;
};

const WO_COLS =
  "id, opportunity_id, account_id, status, work_notes, assigned_to, crew_email, scheduled_start_date, scheduled_end_date, sent_at, crew_emailed_at, voided_at, snapshot_document_id, created_at, updated_at";

/** Load a deal's account context, or null if the deal is missing/deleted. No
 *  Won-gate (like closeout — a Work Order can be started on any live deal; the
 *  scope just autofills from whatever proposal exists). */
async function loadOppContext(
  opportunity_id: string
): Promise<{ account_id: string } | null> {
  const sb = commercialDb();
  const { data } = await sb
    .from("commercial_opportunities")
    .select("id, account_id, deleted_at")
    .eq("id", opportunity_id)
    .maybeSingle();
  const row = data as { account_id: string; deleted_at: string | null } | null;
  if (!row || row.deleted_at) return null;
  return { account_id: row.account_id };
}

/** The single live (non-voided) Work Order for a deal, or null. */
export async function getWorkOrderForOpp(opportunity_id: string): Promise<WorkOrder | null> {
  const sb = commercialDb();
  const { data } = await sb
    .from("commercial_work_orders")
    .select(WO_COLS)
    .eq("opportunity_id", opportunity_id)
    .is("voided_at", null)
    .maybeSingle();
  return (data as WorkOrder | null) ?? null;
}

export async function getWorkOrder(id: string): Promise<WorkOrder | null> {
  const sb = commercialDb();
  const { data } = await sb.from("commercial_work_orders").select(WO_COLS).eq("id", id).maybeSingle();
  return (data as WorkOrder | null) ?? null;
}

export async function createWorkOrder(input: {
  opportunity_id: string;
  created_by_user_id: string;
}): Promise<Result<WorkOrder>> {
  const sb = commercialDb();
  const opp = await loadOppContext(input.opportunity_id);
  if (!opp) return { ok: false, error: "opportunity_not_found" };

  // Guard the one-live-per-opp rule at the app layer too (the partial unique
  // index is the backstop) so we return a friendly error, not a 23505.
  const existing = await getWorkOrderForOpp(input.opportunity_id);
  if (existing) return { ok: true, value: existing };

  const { data: inserted, error } = await sb
    .from("commercial_work_orders")
    .insert({
      opportunity_id: input.opportunity_id,
      account_id: opp.account_id,
      status: "draft",
      created_by_user_id: input.created_by_user_id,
    })
    .select(WO_COLS)
    .maybeSingle();
  if (error || !inserted) {
    // Race with the partial-unique index (one live WO per opp): a concurrent
    // create won. Re-fetch and return the existing one instead of surfacing a
    // raw 23505 to the user.
    const raced = await getWorkOrderForOpp(input.opportunity_id);
    if (raced) return { ok: true, value: raced };
    return { ok: false, error: "Couldn't create the work order — please reload and try again." };
  }
  const wo = inserted as WorkOrder;
  await logInsert("commercial_work_orders", wo.id, wo, input.created_by_user_id);
  return { ok: true, value: wo };
}

/** Point a sent Work Order at its frozen PDF document (best-effort, no audit). */
export async function setWorkOrderSnapshot(id: string, snapshot_document_id: string): Promise<void> {
  const sb = commercialDb();
  await sb.from("commercial_work_orders").update({ snapshot_document_id }).eq("id", id);
}

/** Stamp when the crew was last emailed the PDF (best-effort, no audit). */
export async function markWorkOrderEmailed(id: string): Promise<void> {
  const sb = commercialDb();
  await sb.from("commercial_work_orders").update({ crew_emailed_at: new Date().toISOString() }).eq("id", id);
}

export async function updateWorkOrder(
  id: string,
  patch: {
    work_notes?: string | null;
    assigned_to?: string | null;
    crew_email?: string | null;
    scheduled_start_date?: string | null;
    scheduled_end_date?: string | null;
  },
  actorUserId: string
): Promise<Result<WorkOrder>> {
  const sb = commercialDb();
  const before = await getWorkOrder(id);
  if (!before) return { ok: false, error: "not_found" };
  if (before.status !== "draft") return { ok: false, error: "Only a draft work order can be edited." };

  const row: Record<string, unknown> = { updated_at: new Date().toISOString(), updated_by_user_id: actorUserId };
  // Cap lengths so a long unbroken string can't degrade the PDF layout.
  if (patch.work_notes !== undefined) row.work_notes = patch.work_notes?.trim().slice(0, 2000) || null;
  if (patch.assigned_to !== undefined) row.assigned_to = patch.assigned_to?.trim().slice(0, 200) || null;
  // Basic email shape guard — a malformed value is dropped to null rather than
  // stored (it would just bounce on send). Lowercased + capped.
  if (patch.crew_email !== undefined) {
    const e = patch.crew_email?.trim().toLowerCase() ?? "";
    row.crew_email = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e) ? e.slice(0, 200) : null;
  }
  if (patch.scheduled_start_date !== undefined) row.scheduled_start_date = patch.scheduled_start_date || null;
  if (patch.scheduled_end_date !== undefined) row.scheduled_end_date = patch.scheduled_end_date || null;

  const { data, error } = await sb
    .from("commercial_work_orders")
    .update(row)
    .eq("id", id)
    .select(WO_COLS)
    .maybeSingle();
  if (error || !data) return { ok: false, error: error?.message ?? "update_failed" };
  const after = data as WorkOrder;
  await logUpdate("commercial_work_orders", id, before, after, actorUserId);
  return { ok: true, value: after };
}

/** Move a work order between statuses (DAG-enforced). Optimistic concurrency
 *  guard via `.eq("status", before.status)`. `snapshot_document_id` is written
 *  by the caller (the tool's send action) alongside a "sent" flip. */
export async function changeWorkOrderStatus(
  id: string,
  to: WorkOrderStatus,
  actorUserId: string,
  extra?: { snapshot_document_id?: string | null }
): Promise<Result<WorkOrder>> {
  const sb = commercialDb();
  const before = await getWorkOrder(id);
  if (!before) return { ok: false, error: "not_found" };
  const allowed = ALLOWED_WORK_ORDER_TRANSITIONS[before.status] ?? [];
  // Reject same-status no-ops too (the allowed sets never include the current
  // status). Without this, a stale-tab "Send to crew" on an already-sent WO
  // would pass the guard and re-file a duplicate PDF + re-stamp sent_at.
  if (!allowed.includes(to)) {
    return { ok: false, error: `Cannot move a work order from ${before.status} to ${to}.` };
  }

  const row: Record<string, unknown> = {
    status: to,
    updated_at: new Date().toISOString(),
    updated_by_user_id: actorUserId,
  };
  if (to === "sent") row.sent_at = new Date().toISOString();
  if (to === "voided") row.voided_at = new Date().toISOString();
  // Re-opening a sent WO to draft clears the frozen sent stamp so the next send
  // re-snapshots cleanly.
  if (to === "draft") row.sent_at = null;
  if (extra?.snapshot_document_id !== undefined) row.snapshot_document_id = extra.snapshot_document_id;

  const { data, error } = await sb
    .from("commercial_work_orders")
    .update(row)
    .eq("id", id)
    .eq("status", before.status)
    .select(WO_COLS)
    .maybeSingle();
  if (error) return { ok: false, error: error.message };
  if (!data) return { ok: false, error: "This work order just changed in another tab — reload." };
  const after = data as WorkOrder;
  await logUpdate("commercial_work_orders", id, before, after, actorUserId);
  return { ok: true, value: after };
}

/** Cross-account index rows for the sidebar Work Orders queue. Returns the one
 *  live WO per opportunity (there's at most one). "Not created" is derived by
 *  the caller for opps with no row here. */
export type WorkOrderIndexRow = {
  id: string;
  opportunity_id: string;
  account_id: string;
  status: WorkOrderStatus;
  sent_at: string | null;
  updated_at: string;
};

export async function listAllWorkOrders(): Promise<WorkOrderIndexRow[]> {
  const sb = commercialDb();
  const { data } = await sb
    .from("commercial_work_orders")
    .select("id, opportunity_id, account_id, status, sent_at, updated_at")
    .is("voided_at", null)
    .order("updated_at", { ascending: false });
  return (data ?? []) as WorkOrderIndexRow[];
}

// ────────────── Autofill: compose the WO body from proposal + finishes ──────

export type WorkOrderScopeLine = {
  product_name: string | null;
  description: string;
  quantity: number;
  unit: string;
  is_labor: boolean;
  phase: string | null;
};

export type WorkOrderFinishRow = {
  code: string;
  location_description: string | null;
  product_name: string | null;
  manufacturer: string | null;
  color: string | null;
  sheen: string | null;
  finish_type: string | null;
  notes: string | null;
};

export type WorkOrderContent = {
  /** The proposal the scope was drawn from (won preferred; else latest). */
  proposal_revision: number | null;
  proposal_status: string | null;
  inclusions: WorkOrderScopeLine[];
  alternates: WorkOrderScopeLine[];
  exclusions: string[];
  finishes: WorkOrderFinishRow[];
  /** True when there was no proposal at all to autofill from. */
  no_proposal: boolean;
};

/** Build the crew-facing content for a Work Order: scope (inclusions + labor +
 *  alternates + exclusions) from the accepted proposal — or the latest proposal
 *  if none is won yet — plus the Room Finish Schedule. Degrades gracefully:
 *  empty finishes and/or no proposal both return empty sections, never throw. */
export async function buildWorkOrderContent(opportunity_id: string): Promise<WorkOrderContent> {
  const [{ getAcceptedProposalForOpp, listProposalsForOpp, listLineItemsForProposal }, { listExclusions }, { listOpportunityFinishes }] =
    await Promise.all([
      import("@/lib/commercial/proposals/db"),
      import("@/lib/commercial/exclusions/db"),
      import("@/lib/commercial/opportunities/finishes"),
    ]);

  // Prefer the won proposal; fall back to the highest-revision non-deleted one.
  const accepted = await getAcceptedProposalForOpp(opportunity_id);
  let proposal = accepted?.proposal ?? null;
  if (!proposal) {
    const all = await listProposalsForOpp(opportunity_id);
    proposal = all.length > 0 ? all[0]! : null; // listProposalsForOpp is revision-desc
  }

  const finishesRaw = await listOpportunityFinishes(opportunity_id).catch(() => []);
  const finishes: WorkOrderFinishRow[] = finishesRaw.map((f) => ({
    code: f.code,
    location_description: f.location_description ?? null,
    product_name: f.product_name ?? null,
    manufacturer: f.manufacturer ?? null,
    color: f.color ?? null,
    sheen: f.sheen ?? null,
    finish_type: f.finish_type ?? null,
    notes: f.notes ?? null,
  }));

  if (!proposal) {
    return {
      proposal_revision: null,
      proposal_status: null,
      inclusions: [],
      alternates: [],
      exclusions: [],
      finishes,
      no_proposal: true,
    };
  }

  const lines = await listLineItemsForProposal(proposal.id);
  const toScope = (l: (typeof lines)[number]): WorkOrderScopeLine => ({
    product_name: l.product_name ?? null,
    description: l.description,
    quantity: Number(l.quantity),
    unit: l.unit,
    is_labor: !!l.is_labor,
    phase: l.phase ?? null,
  });
  const inclusions = lines.filter((l) => !l.is_alternate).map(toScope);
  const alternates = lines.filter((l) => l.is_alternate).map(toScope);

  // Resolve library exclusions (ordered) + append per-proposal custom lines.
  const allEx = await listExclusions({ activeOnly: false }).catch(() => []);
  const byId = new Map(allEx.map((e) => [e.id, e.text] as const));
  // Cap each exclusion at 500 chars (mirrors the proposal PDF) so a pathological
  // direct-DB write can't blow the WO PDF layout.
  const cap = (t: string) => (t.length > 500 ? t.slice(0, 500) + "…" : t);
  const libraryTexts = (proposal.exclusion_ids ?? [])
    .map((id) => byId.get(id))
    .filter((t): t is string => Boolean(t && t.trim()))
    .map(cap);
  const customTexts = (proposal.custom_exclusions ?? []).filter((t) => t && t.trim()).map(cap);
  const exclusions = [...libraryTexts, ...customTexts];

  return {
    proposal_revision: proposal.revision_number,
    proposal_status: proposal.status,
    inclusions,
    alternates,
    exclusions,
    finishes,
    no_proposal: false,
  };
}
