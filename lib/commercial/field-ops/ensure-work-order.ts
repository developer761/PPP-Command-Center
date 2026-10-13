import "server-only";

import { commercialDb } from "@/lib/commercial/db";

/**
 * Create the FIELD OPS half of a job when the deal is won.
 *
 * Mary, 2026-10-13: *"I am not seeing some Opportunities in the Attendance
 * drop-down box. Cummins and Motormindz are examples. I see them in the
 * opportunity but not in the dropdown."*
 *
 * The Attendance picker lists WORK ORDERS, because hours are logged against a
 * job and not against a deal. All 92 migrated jobs have one — the importer
 * builds a job per Salesforce work order. A deal won HERE got a project
 * (`ensureProjectForOpportunity`) and no job, so it was invisible to Field Ops:
 * won, carrying money, with nowhere to record the crew standing on it.
 *
 * Three deals were in that state when she wrote — MotorMindz ($30,000, with a
 * proposal and costs already against it), Flagstar Bank Trash Enclosures, and
 * Thermo Fisher. That population only grows as Tomco moves off Salesforce,
 * which is why this is fixed at the win rather than noticed job by job.
 *
 * ── WHY THIS IS SAFE TO CALL ON EVERY WIN ────────────────────────────────────
 *
 * `createJob` already refuses when the deal owns a live job — the guard that
 * stops one deal spawning two job codes and splitting payroll across them. So
 * a re-win, a sub-status edit, the reconciler, or a second call for any reason
 * reaches that guard and changes nothing. This checks first anyway, so the
 * ordinary case is a read rather than a refused insert.
 *
 * It deliberately does NOT schedule anything. `target_start` and `target_end`
 * are left null and the status is `ready_to_schedule`, which is exactly what it
 * is: a real job, on the board, waiting for a date. Inventing dates from the
 * deal's `proposed_start_at` would put guesses on Brendan's calendar and on the
 * crews' week.
 */

export type EnsureWorkOrderResult =
  | { ok: true; created: false; reason: "already has one" | "not won" }
  | { ok: true; created: true; jobId: string; jobCode: string }
  | { ok: false; error: string };

type Opp = {
  id: string;
  title: string | null;
  client_name: string | null;
  account_id: string | null;
  status: string | null;
  sub_status: string | null;
  deleted_at: string | null;
  archived_at: string | null;
  property_street: string | null;
  property_city: string | null;
  property_state: string | null;
  property_zip: string | null;
};

export async function ensureWorkOrderForWonOpportunity(
  oppId: string,
  opts?: { actingUserId?: string | null },
): Promise<EnsureWorkOrderResult> {
  const sb = commercialDb();

  const { data: opp, error: oppErr } = await sb
    .from("commercial_opportunities")
    .select(
      "id, title, client_name, account_id, status, sub_status, deleted_at, archived_at, property_street, property_city, property_state, property_zip",
    )
    .eq("id", oppId)
    .maybeSingle();
  if (oppErr) return { ok: false, error: oppErr.message };
  if (!opp) return { ok: false, error: "Deal not found." };

  const o = opp as Opp;
  if (o.deleted_at || o.archived_at) return { ok: true, created: false, reason: "not won" };

  /*
   * The same definition Field Ops' own picker uses — a freshly won deal, or one
   * already in delivery. Kept in step with `listDealOptionsForWorkOrder`: a
   * deal this refuses to make a job for must also be one that picker refuses to
   * offer, or the two disagree about what "current work" means.
   */
  const won =
    (o.status === "pre_sale_closed" && o.sub_status === "won") ||
    ["pre_construction", "in_progress", "billing"].includes(o.status ?? "");
  if (!won) return { ok: true, created: false, reason: "not won" };

  // A job may already exist — from the importer, from the one-off flow, or from
  // somebody adding it by hand before this ran.
  const { data: existing, error: exErr } = await sb
    .from("commercial_jobs")
    .select("id")
    .eq("opportunity_id", oppId)
    .is("deleted_at", null)
    .limit(1)
    .maybeSingle();
  if (exErr) return { ok: false, error: exErr.message };
  if (existing) return { ok: true, created: false, reason: "already has one" };

  // `createJob` needs the account, and every money table keys on it.
  const accountId = o.account_id;
  if (!accountId) {
    return { ok: false, error: "Deal has no account — cannot make a work order for it." };
  }

  const { createJob } = await import("@/lib/commercial/field-ops/jobs");
  const res = await createJob({
    // Blank code: `createJob` derives one from the name, which is what the
    // scheduler would have typed anyway.
    job_code: "",
    name: (o.title ?? "").trim() || "Work order",
    opportunity_id: oppId,
    account_id: accountId,
    customer_name: (o.client_name ?? "").trim(),
    site_address: (o.property_street ?? "").trim(),
    site_city: (o.property_city ?? "").trim(),
    site_state: (o.property_state ?? "").trim(),
    site_zip: (o.property_zip ?? "").trim(),
    // Not scheduled, on purpose — see the docblock.
    status: "ready_to_schedule",
    estimated_labor_hours: null,
    target_start: null,
    target_end: null,
    notes: "Created automatically when the deal was won.",
    // Nullable on purpose: the reconciler and the importer have no signed-in
    // user, and this column is a uuid — `?? ""` would be a type error at the
    // database, not a blank.
    actor_user_id: opts?.actingUserId ?? null,
  });

  if (!res.ok) {
    // The duplicate guard inside createJob is a success for our purposes —
    // something else made the job between our check and the insert.
    if (/already has a work order|already in use/i.test(res.error)) {
      return { ok: true, created: false, reason: "already has one" };
    }
    return { ok: false, error: res.error };
  }
  return { ok: true, created: true, jobId: res.job.id, jobCode: res.job.job_code ?? "" };
}
