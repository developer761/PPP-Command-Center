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
  /** Proposal line items this WO covers. EMPTY means the WHOLE proposal —
   *  that's what every pre-selection work order means, so it stays the
   *  backward-compatible default rather than "no scope" (migration 123). */
  scope_line_item_ids: string[];
  /** Optional area/phase tag for the crew sheet, e.g. "Level 3". */
  area_label: string | null;
  created_at: string;
  updated_at: string;
};

const WO_COLS =
  "id, opportunity_id, account_id, status, work_notes, assigned_to, crew_email, scheduled_start_date, scheduled_end_date, sent_at, crew_emailed_at, voided_at, snapshot_document_id, scope_line_item_ids, area_label, created_at, updated_at";

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
/** Every live work order on a deal, oldest first — that's the order they were
 *  handed out in, and it's what the A/B/C suffix on WO-#### follows. */
export async function listWorkOrdersForOpp(opportunity_id: string): Promise<WorkOrder[]> {
  const sb = commercialDb();
  const { data } = await sb
    .from("commercial_work_orders")
    .select(WO_COLS)
    .eq("opportunity_id", opportunity_id)
    .is("voided_at", null)
    .order("created_at", { ascending: true })
    .order("id", { ascending: true });
  return (data as WorkOrder[] | null) ?? [];
}

/** The FIRST live work order on a deal.
 *
 *  Since migration 123 a deal can have several (scope split across crews), so
 *  this is no longer "the" work order — it's the primary/earliest one. Kept
 *  for the callers that legitimately want just one: the Field Ops job link
 *  (one job per deal, migration 120) and the deal's summary tiles. Anything
 *  showing the user their work orders should use listWorkOrdersForOpp. */
export async function getWorkOrderForOpp(opportunity_id: string): Promise<WorkOrder | null> {
  const all = await listWorkOrdersForOpp(opportunity_id);
  return all[0] ?? null;
}

export async function getWorkOrder(id: string): Promise<WorkOrder | null> {
  const sb = commercialDb();
  const { data } = await sb.from("commercial_work_orders").select(WO_COLS).eq("id", id).maybeSingle();
  return (data as WorkOrder | null) ?? null;
}

export async function createWorkOrder(input: {
  opportunity_id: string;
  created_by_user_id: string;
  /** Proposal line items for THIS sheet. Omit/empty = the whole proposal. */
  scope_line_item_ids?: string[];
  area_label?: string | null;
  /** Migration 123 allows several per deal. Callers that just want to land on
   *  a deal's work order (the tool's "open it" path) pass true so a second
   *  visit doesn't quietly mint an extra empty sheet; the explicit
   *  "Add another work order" button passes false. */
  reuse_existing?: boolean;
}): Promise<Result<WorkOrder>> {
  const sb = commercialDb();
  const opp = await loadOppContext(input.opportunity_id);
  if (!opp) return { ok: false, error: "opportunity_not_found" };

  if (input.reuse_existing) {
    const existing = await getWorkOrderForOpp(input.opportunity_id);
    if (existing) return { ok: true, value: existing };
  }

  // Adding a SECOND (or third) sheet: seed it with the scope nobody has yet.
  // That's what "split the rest across crews" means in practice, and it stops
  // a fresh sheet defaulting to the ENTIRE proposal — which would hand crew 2
  // all of crew 1's work if it were sent without editing.
  let seededScope = input.scope_line_item_ids;
  if (!seededScope?.length && !input.reuse_existing) {
    const siblings = await listWorkOrdersForOpp(input.opportunity_id);
    if (siblings.length > 0) {
      const remainder = await listUnassignedScopeForOpp(input.opportunity_id);
      // If everything is already assigned the remainder is empty; leaving the
      // selection empty there would silently mean "print everything", so fall
      // back to a single sentinel-free empty sheet and let the tool warn.
      seededScope = remainder.map((l) => l.id);
    }
  }

  const { data: inserted, error } = await sb
    .from("commercial_work_orders")
    .insert({
      opportunity_id: input.opportunity_id,
      account_id: opp.account_id,
      status: "draft",
      scope_line_item_ids: seededScope ?? [],
      area_label: input.area_label?.trim() || null,
      created_by_user_id: input.created_by_user_id,
    })
    .select(WO_COLS)
    .maybeSingle();
  if (error || !inserted) {
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
    /** Migration 123 — which proposal lines this sheet covers. EMPTY = all. */
    scope_line_item_ids?: string[];
    area_label?: string | null;
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
  if (patch.area_label !== undefined) row.area_label = patch.area_label?.trim().slice(0, 120) || null;
  if (patch.scope_line_item_ids !== undefined) {
    // De-dupe and drop anything that isn't a uuid — the form posts one value
    // per checked box, and a hand-crafted POST shouldn't be able to stuff
    // arbitrary text into the column.
    const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    row.scope_line_item_ids = Array.from(
      new Set((patch.scope_line_item_ids ?? []).filter((v) => UUID.test(v)))
    );
  }
  // One OR MORE crew emails (comma/semicolon/whitespace-separated) — each
  // shape-guarded; invalid tokens are dropped (they'd just bounce on send).
  // Stored as a clean comma-joined list; the send action splits it back out.
  if (patch.crew_email !== undefined) {
    const valid = (patch.crew_email ?? "")
      .split(/[\s,;]+/)
      .map((e) => e.trim().toLowerCase())
      .filter((e) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e));
    // De-dup, keep order, cap the joined string.
    const uniq = [...new Set(valid)];
    row.crew_email = uniq.length > 0 ? uniq.join(", ").slice(0, 500) : null;
  }
  if (patch.scheduled_start_date !== undefined) row.scheduled_start_date = patch.scheduled_start_date || null;
  if (patch.scheduled_end_date !== undefined) row.scheduled_end_date = patch.scheduled_end_date || null;
  // Don't persist an inverted range (autosave sets both fields) — it would print
  // "Scheduled start → finish" backwards on the crew PDF. Clamp finish up to start.
  if (
    typeof row.scheduled_start_date === "string" &&
    typeof row.scheduled_end_date === "string" &&
    row.scheduled_end_date < row.scheduled_start_date
  ) {
    row.scheduled_end_date = row.scheduled_start_date;
  }

  const { data, error } = await sb
    .from("commercial_work_orders")
    .update(row)
    .eq("id", id)
    .select(WO_COLS)
    .maybeSingle();
  if (error || !data) return { ok: false, error: error?.message ?? "update_failed" };
  const after = data as WorkOrder;
  await logUpdate("commercial_work_orders", id, before, after, actorUserId);

  // Keep the Field-Ops job's target window in step with the WO. jobs.ts copies
  // scheduled_start/end into commercial_jobs.target_start/end only at job
  // CREATION, so editing the WO dates afterward left the scheduler showing the
  // stale window (audit FO6). Propagate on change; best-effort — the WO update
  // already succeeded and a job that doesn't exist yet is created with the fresh
  // dates when the WO is sent.
  const startChanged = patch.scheduled_start_date !== undefined && after.scheduled_start_date !== before.scheduled_start_date;
  const endChanged = patch.scheduled_end_date !== undefined && after.scheduled_end_date !== before.scheduled_end_date;
  if (startChanged || endChanged) {
    const { error: jobErr } = await sb
      .from("commercial_jobs")
      .update({
        target_start: after.scheduled_start_date,
        target_end: after.scheduled_end_date,
        updated_at: new Date().toISOString(),
      })
      .eq("work_order_id", id)
      .is("deleted_at", null);
    if (jobErr) console.warn(`[work-orders] job target-date sync failed for WO ${id}: ${jobErr.message}`);
  }
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
  // R10: when a WO is sent to the crew, make it schedulable in Field Ops (a
  // linked job appears on the Week Grid). Best-effort; dynamic import breaks the
  // field-ops <-> work-orders cycle.
  if (to === "sent") {
    const { ensureJobForWorkOrder } = await import("@/lib/commercial/field-ops/jobs");
    await ensureJobForWorkOrder(id, actorUserId);
  }
  // Voiding the WO must tear down its Field Ops twin — otherwise the crew stay
  // scheduled + get clock-in nudges for a cancelled work order, and a re-created
  // WO spawns a duplicate live job (audit round 7). softDeleteJob cancels future
  // assignments + resyncs nudges + soft-deletes the job (so no duplicate on
  // re-send). Best-effort.
  if (to === "voided") {
    try {
      const { data: jobRow } = await sb
        .from("commercial_jobs")
        .select("id")
        .eq("work_order_id", id)
        .is("deleted_at", null)
        .maybeSingle();
      if (jobRow) {
        // A deal has ONE Field Ops job (migration 120) but can now have several
        // work orders (123), and the extra sheets deliberately REUSE that job
        // without re-pointing work_order_id. So the job found here may still be
        // carrying other live sheets' crews: tearing it down would cancel every
        // future assignment on the deal because ONE sheet was voided, leaving
        // the other crews silently unscheduled.
        //
        // Only tear the job down when this is the last live sheet on the deal.
        const { data: siblings } = await sb
          .from("commercial_work_orders")
          .select("id")
          .eq("opportunity_id", before.opportunity_id)
          .is("voided_at", null)
          .neq("id", id);
        const othersLive = ((siblings ?? []) as { id: string }[]).length > 0;
        if (!othersLive) {
          const { softDeleteJob } = await import("@/lib/commercial/field-ops/jobs");
          await softDeleteJob((jobRow as { id: string }).id, actorUserId);
        } else {
          // Hand the job to a surviving sheet so re-opening THAT one still
          // controls it, and so the link doesn't dangle at a voided row.
          const heir = ((siblings ?? []) as { id: string }[])[0];
          await sb
            .from("commercial_jobs")
            .update({ work_order_id: heir.id, updated_at: new Date().toISOString() })
            .eq("id", (jobRow as { id: string }).id);
        }
      }
    } catch (err) {
      console.warn("[work-orders] void teardown failed:", err);
    }
  }
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
export async function buildWorkOrderContent(
  opportunity_id: string,
  /** Restrict the scope to these proposal line items (migration 123). EMPTY or
   *  omitted = the whole proposal, which is what every work order created
   *  before scope selection existed means — so the default can never silently
   *  blank an existing crew sheet. */
  scopeLineItemIds?: string[] | null
): Promise<WorkOrderContent> {
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

  const allLines = await listLineItemsForProposal(proposal.id);
  // Filter to this sheet's selection. An id that no longer resolves (the line
  // was deleted from the proposal after the WO was built) simply drops out —
  // the rest of the sheet stands, which is why this isn't a foreign key.
  const selected = new Set(scopeLineItemIds ?? []);
  const lines = selected.size > 0 ? allLines.filter((l) => selected.has(l.id)) : allLines;
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

// ────────────── scope selection (migration 123) ──────────────

export type PickableScopeLine = {
  id: string;
  label: string;
  is_alternate: boolean;
  is_labor: boolean;
  phase: string | null;
};

/**
 * The proposal line items a work order can be built from, for THIS deal.
 *
 * Same proposal-choosing rule as buildWorkOrderContent (accepted proposal
 * preferred, else the latest), so the picker and the printed sheet can never
 * disagree about which revision they're working from.
 */
export async function listPickableScopeForOpp(
  opportunity_id: string
): Promise<{ proposalId: string | null; lines: PickableScopeLine[] }> {
  const { getAcceptedProposalForOpp, listProposalsForOpp, listLineItemsForProposal } =
    await import("@/lib/commercial/proposals/db");
  const accepted = await getAcceptedProposalForOpp(opportunity_id);
  let proposal = accepted?.proposal ?? null;
  if (!proposal) {
    const all = await listProposalsForOpp(opportunity_id);
    proposal = all.length > 0 ? all[0]! : null;
  }
  if (!proposal) return { proposalId: null, lines: [] };
  const items = await listLineItemsForProposal(proposal.id);
  return {
    proposalId: proposal.id,
    lines: items.map((l) => ({
      id: l.id,
      label: (l.description?.trim() || l.product_name?.trim() || "(untitled line)").slice(0, 200),
      is_alternate: !!l.is_alternate,
      is_labor: !!l.is_labor,
      phase: l.phase ?? null,
    })),
  };
}

/**
 * Scope on the proposal that no live work order covers yet.
 *
 * This is the "nothing gets quietly dropped" check Karan asked for: splitting a
 * job across crews is exactly when a line goes missing, because each sheet
 * looks complete on its own. Anything nobody has been handed shows up here.
 *
 * A work order with an EMPTY selection covers the whole proposal (see migration
 * 123), so if any live WO is unselected there is by definition nothing
 * unassigned — every line is already on someone's sheet.
 */
export async function listUnassignedScopeForOpp(
  opportunity_id: string
): Promise<PickableScopeLine[]> {
  const [{ lines }, workOrders] = await Promise.all([
    listPickableScopeForOpp(opportunity_id),
    listWorkOrdersForOpp(opportunity_id),
  ]);
  if (lines.length === 0 || workOrders.length === 0) return lines;
  // "Empty = the whole proposal" is a BACKWARD-COMPATIBILITY rule for the era
  // when a deal could only have one work order (migration 106's unique index,
  // dropped by 123). It must not apply once the scope is being split, or the
  // safety net switches itself off at exactly the moment it's needed: sheet A
  // covers 4 of 8 lines, you click "Add another", the new sheet is empty,
  // `some(empty)` reads as "someone has everything", and the "4 lines not on
  // any work order" banner vanishes.
  //
  // Any deal with 2+ live sheets is necessarily post-123, so there an empty
  // selection means "not chosen yet", never "everything".
  const soleSheetCoversEverything =
    workOrders.length === 1 && (workOrders[0].scope_line_item_ids ?? []).length === 0;
  if (soleSheetCoversEverything) return [];
  const assigned = new Set(workOrders.flatMap((wo) => wo.scope_line_item_ids ?? []));
  return lines.filter((l) => !assigned.has(l.id));
}

/**
 * Re-point every work order's stored scope at a new set of line-item ids.
 *
 * A proposal revision copies the parent's line items as BRAND-NEW rows with
 * brand-new ids. Work orders store the ids they were built from, so after a
 * bump every stored id matched nothing: buildWorkOrderContent filtered down to
 * zero and printed a sheet with no scope of work on it, while the tool's
 * "5 of 8 lines" label — computed from the raw array length — still said 5.
 * Re-open a sent work order, re-send it, and that's what the crew received.
 *
 * `idRemap` is old id -> new id. Ids with no mapping are DROPPED rather than
 * kept: a line the estimator deleted during the revision genuinely isn't in
 * the scope any more, and keeping a dangling id would quietly re-add it if a
 * future line ever reused the id.
 *
 * Best-effort and never throws — a failed remap must not fail the revision.
 */
export async function remapWorkOrderScopeForOpp(
  opportunity_id: string,
  idRemap: Map<string, string>,
  actorUserId: string
): Promise<number> {
  if (idRemap.size === 0) return 0;
  const sb = commercialDb();
  const workOrders = await listWorkOrdersForOpp(opportunity_id);
  let updated = 0;
  for (const wo of workOrders) {
    const current = wo.scope_line_item_ids ?? [];
    // Empty means "the whole proposal" — there's nothing to re-point, and
    // writing ids here would silently convert it to a partial sheet.
    if (current.length === 0) continue;
    const next = current
      .map((id) => idRemap.get(id))
      .filter((v): v is string => !!v);
    if (next.length === current.length && next.every((v, i) => v === current[i])) continue;
    const { error } = await sb
      .from("commercial_work_orders")
      .update({ scope_line_item_ids: next, updated_at: new Date().toISOString() })
      .eq("id", wo.id);
    if (error) continue;
    await logUpdate(
      "commercial_work_orders",
      wo.id,
      { scope_line_item_ids: current },
      { scope_line_item_ids: next },
      actorUserId
    ).catch(() => undefined);
    updated += 1;
  }
  return updated;
}

// ── Crew-facing scope (2026-08) ────────────────────────────────────────────

export type CrewScope = {
  /** The lines this crew is actually working, in proposal order. */
  lines: string[];
  /** Total lines on the project, so "3 of 6" can be stated. */
  totalLines: number;
  /** True when this sheet is only part of the job. */
  isPartial: boolean;
  /** Optional area tag ("Level 3"), if the sheet carries one. */
  areaLabel: string | null;
  /**
   * Optional add-ons the customer has NOT bought, kept separate from `lines`.
   *
   * Never merge these into the scope list: crew surfaces render one flat set of
   * bullets, so an alternate shown there reads as work to do — and painting an
   * unsold alternate is unbilled labor.
   */
  alternates: string[];
};

/**
 * What a crew member needs to be told about a job, in one call.
 *
 * The scope selection reached the PDF and nowhere else — not the schedule
 * email, not the magic-link page, not the Field Ops work order. Those are the
 * three places a crew member actually looks, so someone scheduled onto a job
 * was told WHERE and WHEN but never WHAT (Karan, testing it himself 2026-08).
 *
 * Resolves from the deal, picking the live work order that best matches: a
 * SENT sheet first (that's the one a crew was handed), else the earliest live
 * one. Returns null when there's no work order or no proposal scope yet —
 * callers then simply say nothing rather than printing an empty section.
 */
export async function getCrewScopeForOpp(
  opportunity_id: string,
  /** Narrow to one sheet when the caller knows which (e.g. a job's work_order_id). */
  workOrderId?: string | null
): Promise<CrewScope | null> {
  const workOrders = await listWorkOrdersForOpp(opportunity_id);
  if (workOrders.length === 0) return null;
  const wo =
    (workOrderId && workOrders.find((w) => w.id === workOrderId)) ||
    workOrders.find((w) => w.status === "sent") ||
    workOrders[0];
  if (!wo) return null;

  const [content, all] = await Promise.all([
    buildWorkOrderContent(opportunity_id, wo.scope_line_item_ids),
    buildWorkOrderContent(opportunity_id, null),
  ]);
  const toText = (l: { product_name: string | null; description: string }) =>
    (l.description?.trim() || l.product_name?.trim() || "").trim();
  // Base inclusions ONLY. Alternates are optional add-ons the customer hasn't
  // bought — crew surfaces render one flat bullet list, so folding them in here
  // presents unsold work as the job. It also broke the partial count: a sheet
  // covering every real inclusion but no alternates read "5 of 7 — the rest is
  // on another work order" when there is no other work order.
  const lines = content.inclusions.map(toText).filter(Boolean);
  const totalLines = all.inclusions.length;
  const alternates = content.alternates.map(toText).filter(Boolean);
  if (lines.length === 0) return null;
  return {
    lines,
    totalLines,
    isPartial: totalLines > 0 && lines.length < totalLines,
    areaLabel: wo.area_label?.trim() || null,
    alternates,
  };
}

/**
 * Crew scope resolved from a Field Ops JOB rather than a deal.
 *
 * The crew-facing surfaces (magic link, work-order card, schedule email) all
 * hold a job id, not an opportunity id — so this does the hop for them and
 * uses the job's own `work_order_id` to pick the right sheet when a project
 * has several.
 */
export async function getCrewScopeForJob(
  jobId: string | null | undefined
): Promise<CrewScope | null> {
  if (!jobId) return null;
  const sb = commercialDb();
  const { data } = await sb
    .from("commercial_jobs")
    .select("opportunity_id, work_order_id")
    .eq("id", jobId)
    .maybeSingle();
  const row = data as { opportunity_id: string | null; work_order_id: string | null } | null;
  if (!row?.opportunity_id) return null;
  return getCrewScopeForOpp(row.opportunity_id, row.work_order_id);
}
