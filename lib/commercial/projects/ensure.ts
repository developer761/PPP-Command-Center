import "server-only";

import { commercialDb } from "@/lib/commercial/db";

/**
 * Create the PROJECT half of a job when it is won.
 *
 * The opportunity captures the sale; the project captures the work, and carries
 * its own owner (the PM, not the estimator) and its own amount (the contract,
 * not the quote). See migration 131.
 *
 * Hangs off `changeOpportunityStatus` — the one writer every path already goes
 * through — so the board, the auto-advance engine, the debrief form and the
 * repair screen all get this for free rather than each carrying a copy.
 *
 * Best-effort by design. A job must never fail to be marked won because its
 * project row couldn't be written; the reconcile pass and the next status
 * change both re-attempt, and `ensureProjectForOpportunity` is idempotent.
 */

/** Delivery-phase status of the project, derived from the deal's status. */
export type ProjectStatus =
  | "awarded"
  | "pre_construction"
  | "in_progress"
  | "billing"
  | "closed_out";

export type CommercialProject = {
  id: string;
  opportunity_id: string | null;
  project_number: string | null;
  name: string;
  owner_user_id: string | null;
  contract_base_cents: number | null;
  contract_source: string | null;
  status: ProjectStatus;
  started_at: string | null;
  substantially_complete_at: string | null;
  closed_out_at: string | null;
  archived_at: string | null;
  deleted_at: string | null;
};

/**
 * Should this deal have a project, and at what stage?
 *
 * Pure, and the reason it is: the rule was wrong in the first draft of the plan
 * and only live data caught it. It read "entering a delivery status", which
 * describes 1 of the 9 real deals — the other 7 sit in `pre_sale_closed/won`
 * already carrying invoices, AIA applications and work orders.
 *
 * **Being won is the trigger.** A delivery status is an additional entry point,
 * for a deal dragged past the win without ever being formally closed
 * (`WARN_TRANSITIONS` exists precisely because that happens).
 */
export function projectStateForOpportunity(
  status: string,
  subStatus: string | null
): { shouldExist: boolean; projectStatus: ProjectStatus } {
  switch (status) {
    case "pre_construction":
      return { shouldExist: true, projectStatus: "pre_construction" };
    case "in_progress":
      return { shouldExist: true, projectStatus: "in_progress" };
    case "billing":
      return { shouldExist: true, projectStatus: "billing" };
    case "post_sale_closed":
      return { shouldExist: true, projectStatus: "closed_out" };
    case "pre_sale_closed":
      // Won → awarded. Lost → no project. This is the case the ladder-position
      // rule missed entirely.
      return subStatus === "won"
        ? { shouldExist: true, projectStatus: "awarded" }
        : { shouldExist: false, projectStatus: "awarded" };
    default:
      return { shouldExist: false, projectStatus: "awarded" };
  }
}

/** Pre-migration-131 shape of "that table isn't there yet". */
function isMissingProjectsTable(message: string): boolean {
  return /commercial_projects/i.test(message) &&
    /(does not exist|schema cache|relation)/i.test(message);
}

/**
 * The contract figure at award — set once, never recomputed afterwards.
 *
 * Mirrors the top rungs of `pickContractBaseCents`, stopping where that ladder
 * starts consulting the AIA document (which doesn't exist yet at award) and the
 * bid range (a guess). Below `latest_proposal` the honest answer is NULL, which
 * renders as "contract value not set" — never $0.00, which reads as a real
 * number and poisons every rollup above it.
 */
async function contractAtAward(
  oppId: string,
  acceptedSnapshotCents: number | null
): Promise<{ cents: number | null; source: string | null }> {
  const sb = commercialDb();

  if (acceptedSnapshotCents && acceptedSnapshotCents > 0) {
    return { cents: acceptedSnapshotCents, source: "accepted_snapshot" };
  }

  const { data: rows } = await sb
    .from("commercial_proposals")
    .select("total_cents, status")
    .eq("opportunity_id", oppId)
    .is("deleted_at", null)
    .in("status", ["sent", "won", "lost", "expired", "superseded"]);

  const proposals = (rows ?? []) as { total_cents: number | string; status: string }[];
  const best = (statuses: string[]) =>
    proposals
      .filter((p) => statuses.includes(p.status))
      .map((p) => Number(p.total_cents) || 0)
      .reduce((a, b) => Math.max(a, b), 0);

  const won = best(["won"]);
  if (won > 0) return { cents: won, source: "won_proposal" };

  const seen = best(["sent", "won", "lost", "expired", "superseded"]);
  if (seen > 0) return { cents: seen, source: "latest_proposal" };

  return { cents: null, source: null };
}

/**
 * Make the project row match the deal's current state.
 *
 * Idempotent — the unique constraint on `opportunity_id` means a deal that
 * bounces won → lost → won never produces a second project, and a reconcile
 * pass on any page load is harmless.
 *
 * What it will NOT do on an existing project: overwrite `contract_base_cents`,
 * `contract_source` or `owner_user_id`. Those are set at award and then belong
 * to a person — a PM reassignment or a negotiated figure must survive the next
 * status change. Re-deciding the contract is `snapshotAcceptedContract`'s job.
 */
export async function ensureProjectForOpportunity(
  oppId: string,
  opts?: { actingUserId?: string | null }
): Promise<{ ok: true; project: CommercialProject | null } | { ok: false; error: string }> {
  const sb = commercialDb();

  const { data: oppRow, error: readErr } = await sb
    .from("commercial_opportunities")
    // One literal, not a concatenation — PostgREST's types are inferred from
    // the select string, and a `+` defeats that inference silently.
    .select("id, title, title_override, status, sub_status, project_number, estimator_user_id, created_by_user_id, accepted_contract_cents, closed_out_at, archived_at, deleted_at")
    .eq("id", oppId)
    .maybeSingle();
  if (readErr) return { ok: false, error: readErr.message };
  if (!oppRow) return { ok: false, error: "Opportunity not found." };

  const opp = oppRow as unknown as {
    id: string;
    title: string | null;
    title_override: string | null;
    status: string;
    sub_status: string | null;
    project_number: string | null;
    estimator_user_id: string | null;
    created_by_user_id: string | null;
    accepted_contract_cents: number | string | null;
    closed_out_at: string | null;
    archived_at: string | null;
    deleted_at: string | null;
  };

  const { shouldExist, projectStatus } = projectStateForOpportunity(opp.status, opp.sub_status);

  const { data: existingRow, error: existErr } = await sb
    .from("commercial_projects")
    .select("*")
    .eq("opportunity_id", oppId)
    .maybeSingle();
  if (existErr) {
    if (isMissingProjectsTable(existErr.message)) {
      console.warn(
        "[commercial/projects/ensure] commercial_projects is missing — run migration 131."
      );
      return { ok: true, project: null };
    }
    return { ok: false, error: existErr.message };
  }
  const existing = existingRow as CommercialProject | null;

  // ── The deal is no longer won ────────────────────────────────────────────
  //
  // Archive, never delete. The project may hold invoices, and a job un-won on
  // Tuesday is usually a correction that gets re-won on Wednesday. Deleting
  // would take real money rows with it (the FK is ON DELETE RESTRICT, so it
  // would in fact just fail — loudly, in the middle of someone's status change).
  if (!shouldExist) {
    if (existing && !existing.archived_at) {
      const { error } = await sb
        .from("commercial_projects")
        .update({ archived_at: new Date().toISOString() })
        .eq("id", existing.id);
      if (error) return { ok: false, error: error.message };
    }
    return { ok: true, project: null };
  }

  const name =
    (opp.title_override ?? "").trim() || (opp.title ?? "").trim() || "Untitled project";

  // ── Already exists: reconcile only what the deal still owns ──────────────
  if (existing) {
    const patch: Record<string, unknown> = {};
    if (existing.status !== projectStatus) patch.status = projectStatus;
    // Re-winning a deal un-archives its project rather than making a second one.
    if (existing.archived_at && !opp.archived_at) patch.archived_at = null;
    if (!existing.archived_at && opp.archived_at) patch.archived_at = opp.archived_at;
    if (existing.deleted_at !== opp.deleted_at) patch.deleted_at = opp.deleted_at;
    if (existing.closed_out_at !== opp.closed_out_at) patch.closed_out_at = opp.closed_out_at;
    // The number is set once at award, but a project created before the win was
    // recorded (dragged into delivery on a verbal yes) can legitimately learn it
    // afterwards. Fill a blank; never overwrite a value.
    if (existing.contract_base_cents == null) {
      const { cents, source } = await contractAtAward(
        oppId,
        Number(opp.accepted_contract_cents) || null
      );
      if (cents != null) {
        patch.contract_base_cents = cents;
        patch.contract_source = source;
      }
    }
    if (Object.keys(patch).length === 0) return { ok: true, project: existing };

    const { data, error } = await sb
      .from("commercial_projects")
      .update(patch)
      .eq("id", existing.id)
      .select("*")
      .maybeSingle();
    if (error) return { ok: false, error: error.message };
    return { ok: true, project: (data as CommercialProject) ?? existing };
  }

  // ── Create ───────────────────────────────────────────────────────────────
  const { cents, source } = await contractAtAward(
    oppId,
    Number(opp.accepted_contract_cents) || null
  );

  const { data, error } = await sb
    .from("commercial_projects")
    .insert({
      opportunity_id: oppId,
      // Inherited, never re-issued — the number is already printed on PDFs,
      // emails and AIA cover sheets in the field.
      project_number: opp.project_number,
      name,
      owner_user_id: opp.estimator_user_id ?? opp.created_by_user_id ?? null,
      contract_base_cents: cents,
      contract_source: source,
      status: projectStatus,
      closed_out_at: opp.closed_out_at,
      archived_at: opp.archived_at,
      deleted_at: opp.deleted_at,
      created_by_user_id: opts?.actingUserId ?? opp.created_by_user_id ?? null,
    })
    .select("*")
    .maybeSingle();

  if (error) {
    if (isMissingProjectsTable(error.message)) {
      console.warn(
        "[commercial/projects/ensure] commercial_projects is missing — run migration 131."
      );
      return { ok: true, project: null };
    }
    // Lost a race with a concurrent write — the unique constraint did its job.
    // Read back what the winner created rather than reporting a failure.
    if (/duplicate key|unique constraint/i.test(error.message)) {
      const { data: raced } = await sb
        .from("commercial_projects")
        .select("*")
        .eq("opportunity_id", oppId)
        .maybeSingle();
      return { ok: true, project: (raced as CommercialProject) ?? null };
    }
    return { ok: false, error: error.message };
  }

  // Link any delivery rows already sitting on this deal. Normally none at this
  // point, but a deal dragged into delivery before the win can be invoiced
  // first — the backfill covers history, this covers that ordering.
  await linkDeliveryRows(oppId, (data as CommercialProject).id);

  return { ok: true, project: data as CommercialProject };
}

const DELIVERY_TABLES = [
  "commercial_invoices",
  "commercial_change_orders",
  "commercial_aia_applications",
  "commercial_opp_submittals",
  "commercial_work_orders",
  "commercial_closeout_packages",
  "commercial_project_purchases",
  "commercial_jobs",
] as const;

/** Point this deal's existing delivery rows at the project. Only ever fills a
 *  blank — a row already carrying a project_id was set deliberately. */
async function linkDeliveryRows(oppId: string, projectId: string): Promise<void> {
  const sb = commercialDb();
  for (const table of DELIVERY_TABLES) {
    const { error } = await sb
      .from(table)
      .update({ project_id: projectId })
      .eq("opportunity_id", oppId)
      .is("project_id", null);
    if (error && !isMissingProjectsTable(error.message) && !/project_id/i.test(error.message)) {
      console.warn(`[commercial/projects/ensure] linking ${table} failed:`, error.message);
    }
  }
}

/** The project for a deal, or null. Reads only — no creation side effect. */
export async function getProjectForOpportunity(
  oppId: string
): Promise<CommercialProject | null> {
  const sb = commercialDb();
  const { data, error } = await sb
    .from("commercial_projects")
    .select("*")
    .eq("opportunity_id", oppId)
    .is("deleted_at", null)
    .maybeSingle();
  if (error) {
    if (!isMissingProjectsTable(error.message)) {
      console.warn("[commercial/projects/ensure] getProjectForOpportunity:", error.message);
    }
    return null;
  }
  return (data as CommercialProject) ?? null;
}
