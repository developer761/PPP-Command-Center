import "server-only";

import { commercialDb } from "@/lib/commercial/db";
import { logInsert, logUpdate, logDelete } from "@/lib/commercial/audit-log";
import { todayEtIso } from "./schedule";

/**
 * R10 Field Ops - schedulable jobs (commercial_jobs).
 *
 * Standalone-first: a job is a name + a MANDATORY job_code, optionally backed by
 * a won opportunity or a work order. The crew is shared across PPP + commercial
 * + misc (the "(ppp job)" reality), so most jobs are standalone with a
 * division_tag. job_code is required at creation (reportability discipline).
 */

export const JOB_STATUSES = [
  "estimating",
  "ready_to_schedule",
  "scheduled",
  "in_progress",
  "complete",
  "closed",
  "on_hold",
] as const;
export type JobStatus = (typeof JOB_STATUSES)[number];

export function jobStatusLabel(s: JobStatus): string {
  return {
    estimating: "Estimating",
    ready_to_schedule: "Ready to schedule",
    scheduled: "Scheduled",
    in_progress: "In progress",
    complete: "Complete",
    closed: "Closed",
    on_hold: "On hold",
  }[s];
}

export const DIVISION_TAGS = ["commercial", "ppp", "other"] as const;
export type DivisionTag = (typeof DIVISION_TAGS)[number];
export function divisionLabel(d: string | null): string {
  return d === "ppp" ? "PPP" : d === "other" ? "Other" : d === "commercial" ? "Commercial" : "—";
}

export type CommercialJob = {
  id: string;
  job_code: string;
  name: string;
  opportunity_id: string | null;
  work_order_id: string | null;
  account_id: string | null;
  customer_name: string | null;
  site_address: string | null;
  site_city: string | null;
  site_state: string | null;
  site_zip: string | null;
  status: JobStatus;
  estimated_labor_hours: number | null;
  target_start: string | null;
  target_end: string | null;
  prevailing_wage: boolean;
  division_tag: string | null;
  notes: string | null;
  deleted_at: string | null;
  created_at: string;
  updated_at: string;
};

const COLS =
  "id, job_code, name, opportunity_id, work_order_id, account_id, customer_name, site_address, site_city, site_state, site_zip, status, estimated_labor_hours, target_start, target_end, prevailing_wage, division_tag, notes, deleted_at, created_at, updated_at";

const OPEN_STATUSES: JobStatus[] = [
  "estimating",
  "ready_to_schedule",
  "scheduled",
  "in_progress",
  "on_hold",
];

export async function listJobs(opts?: { includeClosed?: boolean }): Promise<CommercialJob[]> {
  const sb = commercialDb();
  let q = sb.from("commercial_jobs").select(COLS).is("deleted_at", null);
  if (!opts?.includeClosed) q = q.in("status", OPEN_STATUSES);
  const { data, error } = await q.order("target_start", { ascending: true, nullsFirst: false }).order("created_at", { ascending: false });
  if (error) {
    console.warn("[field-ops/jobs] list failed:", error.message);
    return [];
  }
  return (data ?? []) as CommercialJob[];
}

/** Deals (opportunities) to connect a manually-added work order to - the same
 *  platform link a real WO has. Picking one ties the WO to that account + deal. */
export async function listDealOptionsForWorkOrder(): Promise<{ value: string; label: string; account_id: string }[]> {
  const sb = commercialDb();
  const { data: opps } = await sb
    .from("commercial_opportunities")
    .select("id, title, client_name, account_id")
    .is("deleted_at", null)
    .is("archived_at", null) // archived deals are hidden from the pipeline - hide them here too
    .order("updated_at", { ascending: false })
    .limit(300);
  const rows = (opps ?? []) as { id: string; title: string | null; client_name: string | null; account_id: string }[];
  const accIds = [...new Set(rows.map((o) => o.account_id))];
  const accName = new Map<string, string>();
  if (accIds.length > 0) {
    const { data: accs } = await sb.from("commercial_accounts").select("id, company_name").in("id", accIds);
    for (const a of (accs ?? []) as { id: string; company_name: string }[]) accName.set(a.id, a.company_name);
  }
  return rows.map((o) => ({
    value: o.id,
    account_id: o.account_id,
    label: `${accName.get(o.account_id) ?? "GC"} - ${o.title?.trim() || o.client_name?.trim() || "Deal"}`,
  }));
}

/** The account behind an opportunity (for connecting a work order). */
export async function getOpportunityAccountId(oppId: string): Promise<string | null> {
  const sb = commercialDb();
  const { data } = await sb.from("commercial_opportunities").select("account_id").eq("id", oppId).is("deleted_at", null).maybeSingle();
  return (data as { account_id?: string } | null)?.account_id ?? null;
}

export async function getJob(id: string): Promise<CommercialJob | null> {
  const sb = commercialDb();
  const { data } = await sb.from("commercial_jobs").select(COLS).eq("id", id).is("deleted_at", null).maybeSingle();
  return (data as CommercialJob | null) ?? null;
}

export type CreateJobInput = {
  job_code: string;
  name: string;
  customer_name?: string | null;
  site_address?: string | null;
  site_city?: string | null;
  site_state?: string | null;
  site_zip?: string | null;
  status?: JobStatus;
  estimated_labor_hours?: number | null;
  target_start?: string | null;
  target_end?: string | null;
  prevailing_wage?: boolean;
  division_tag?: DivisionTag | null;
  opportunity_id?: string | null;
  work_order_id?: string | null;
  account_id?: string | null;
  notes?: string | null;
  actor_user_id: string;
};

/** Auto-generate a reportable work-order code from the name. Used when the
 *  scheduler doesn't type one (they rarely want to) — the code still exists so
 *  labor rolls up per work order in payroll + reports. Practically unique via a
 *  4-char suffix; the UNIQUE index is the real guard. */
function autoJobCode(name: string): string {
  const base = (name || "WO").toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 8) || "WO";
  const suffix = globalThis.crypto.randomUUID().replace(/[^a-z0-9]/gi, "").slice(0, 4).toUpperCase();
  return `${base}-${suffix}`;
}

export async function createJob(
  input: CreateJobInput
): Promise<{ ok: true; job: CommercialJob } | { ok: false; error: string }> {
  const name = (input.name ?? "").trim();
  if (!name) return { ok: false, error: "Work order name is required." };
  // Code is auto-generated when blank — the scheduler shouldn't have to invent one.
  const code = (input.job_code ?? "").trim() || autoJobCode(name);

  const sb = commercialDb();
  // Friendly duplicate check (the unique index is the real guard).
  const { data: dup } = await sb
    .from("commercial_jobs")
    .select("id")
    .ilike("job_code", code)
    .is("deleted_at", null)
    .limit(1)
    .maybeSingle();
  if (dup) return { ok: false, error: `Job code "${code}" is already in use.` };

  const { data, error } = await sb
    .from("commercial_jobs")
    .insert({
      job_code: code,
      name,
      customer_name: (input.customer_name ?? "").trim() || null,
      site_address: (input.site_address ?? "").trim() || null,
      site_city: (input.site_city ?? "").trim() || null,
      site_state: (input.site_state ?? "").trim() || null,
      site_zip: (input.site_zip ?? "").trim() || null,
      status: input.status ?? "ready_to_schedule",
      estimated_labor_hours: input.estimated_labor_hours ?? null,
      target_start: input.target_start || null,
      target_end: input.target_end || null,
      prevailing_wage: input.prevailing_wage ?? false,
      division_tag: input.division_tag ?? null,
      opportunity_id: input.opportunity_id ?? null,
      work_order_id: input.work_order_id ?? null,
      account_id: input.account_id ?? null,
      notes: (input.notes ?? "").trim() || null,
      created_by_user_id: input.actor_user_id,
    })
    .select(COLS)
    .single();
  if (error) {
    const msg = /duplicate key|unique/i.test(error.message) ? `Job code "${code}" is already in use.` : error.message;
    return { ok: false, error: msg };
  }
  const job = data as CommercialJob;
  await logInsert("commercial_jobs", job.id, job, input.actor_user_id);
  return { ok: true, job };
}

export type UpdateJobInput = Partial<Omit<CreateJobInput, "actor_user_id" | "job_code">> & { job_code?: string };

export async function updateJob(
  id: string,
  patch: UpdateJobInput,
  actorUserId: string
): Promise<{ ok: true; job: CommercialJob } | { ok: false; error: string }> {
  const before = await getJob(id);
  if (!before) return { ok: false, error: "Job not found." };
  const next: Record<string, unknown> = { updated_at: new Date().toISOString() };
  if (patch.job_code !== undefined) {
    const code = patch.job_code.trim();
    if (!code) return { ok: false, error: "Job code can't be blank." };
    next.job_code = code;
  }
  if (patch.name !== undefined) next.name = patch.name.trim();
  if (patch.customer_name !== undefined) next.customer_name = (patch.customer_name ?? "").trim() || null;
  if (patch.site_address !== undefined) next.site_address = (patch.site_address ?? "").trim() || null;
  if (patch.site_city !== undefined) next.site_city = (patch.site_city ?? "").trim() || null;
  if (patch.site_state !== undefined) next.site_state = (patch.site_state ?? "").trim() || null;
  if (patch.site_zip !== undefined) next.site_zip = (patch.site_zip ?? "").trim() || null;
  if (patch.status !== undefined) next.status = patch.status;
  if (patch.estimated_labor_hours !== undefined) next.estimated_labor_hours = patch.estimated_labor_hours;
  if (patch.target_start !== undefined) next.target_start = patch.target_start || null;
  if (patch.target_end !== undefined) next.target_end = patch.target_end || null;
  if (patch.prevailing_wage !== undefined) next.prevailing_wage = patch.prevailing_wage;
  if (patch.division_tag !== undefined) next.division_tag = patch.division_tag ?? null;
  if (patch.notes !== undefined) next.notes = (patch.notes ?? "").trim() || null;

  const sb = commercialDb();
  const { data, error } = await sb.from("commercial_jobs").update(next).eq("id", id).select(COLS).single();
  if (error) {
    const msg = /duplicate key|unique/i.test(error.message) ? "That job code is already in use." : error.message;
    return { ok: false, error: msg };
  }
  const job = data as CommercialJob;
  await logUpdate("commercial_jobs", id, before, job, actorUserId);
  return { ok: true, job };
}

/**
 * WO -> scheduler link: when a deal's Work Order is sent, make sure a
 * schedulable field-ops job exists for it so it appears on the Calendar / Work
 * Orders tab. Idempotent + self-healing:
 *   - a LIVE job already linked  -> nothing to do
 *   - a SOFT-DELETED job for this WO -> revived (was the silent-failure case: the
 *     old code re-inserted the same job_code and hit the UNIQUE index)
 *   - otherwise -> create it, with a collision-proof code fallback
 * Returns a result so callers/backfill can tell it actually worked. Never throws.
 * Queries tables directly (no work-orders import) to avoid a circular dependency.
 */
export async function ensureJobForWorkOrder(
  workOrderId: string,
  actorUserId: string
): Promise<{ ok: true; jobId: string; created: boolean } | { ok: false; error: string }> {
  try {
    const sb = commercialDb();
    // Look at ALL jobs for this WO (incl. soft-deleted) — prefer a live one, else
    // revive the most recent deleted one instead of colliding on job_code.
    const { data: rows } = await sb
      .from("commercial_jobs")
      .select("id, deleted_at")
      .eq("work_order_id", workOrderId)
      .order("created_at", { ascending: false });
    const all = (rows ?? []) as { id: string; deleted_at: string | null }[];
    const live = all.find((r) => !r.deleted_at);
    if (live) return { ok: true, jobId: live.id, created: false };
    if (all.length > 0) {
      // Revive the most recent soft-deleted twin.
      const reviveId = all[0].id;
      const { error } = await sb
        .from("commercial_jobs")
        .update({ deleted_at: null, deleted_by_user_id: null, status: "ready_to_schedule", updated_at: new Date().toISOString() })
        .eq("id", reviveId);
      if (error) return { ok: false, error: error.message };
      await logUpdate("commercial_jobs", reviveId, { deleted_at: "set" }, { deleted_at: null }, actorUserId);
      return { ok: true, jobId: reviveId, created: false };
    }

    const { data: woRow } = await sb
      .from("commercial_work_orders")
      .select("id, opportunity_id, account_id, scheduled_start_date, scheduled_end_date")
      .eq("id", workOrderId)
      .maybeSingle();
    const wo = woRow as {
      opportunity_id: string | null;
      account_id: string | null;
      scheduled_start_date: string | null;
      scheduled_end_date: string | null;
    } | null;
    if (!wo) return { ok: false, error: "Work order not found." };

    const [oppRes, acctRes] = await Promise.all([
      wo.opportunity_id
        ? sb.from("commercial_opportunities").select("title, client_name, project_number").eq("id", wo.opportunity_id).maybeSingle()
        : Promise.resolve({ data: null }),
      wo.account_id
        ? sb.from("commercial_accounts").select("company_name, site_street, site_city, site_state, site_zip").eq("id", wo.account_id).maybeSingle()
        : Promise.resolve({ data: null }),
    ]);
    const opp = oppRes.data as { title: string | null; client_name: string | null; project_number: string | null } | null;
    const acct = acctRes.data as { company_name: string | null; site_street: string | null; site_city: string | null; site_state: string | null; site_zip: string | null } | null;

    const name = opp?.title?.trim() || opp?.client_name?.trim() || acct?.company_name?.trim() || "Work order";
    const baseCode = `${opp?.project_number?.trim() || "WO"}-${workOrderId.slice(0, 6).toUpperCase()}`;
    const jobRow = {
      name,
      opportunity_id: wo.opportunity_id,
      work_order_id: workOrderId,
      account_id: wo.account_id,
      customer_name: acct?.company_name ?? null,
      site_address: acct?.site_street ?? null,
      site_city: acct?.site_city ?? null,
      site_state: acct?.site_state ?? null,
      site_zip: acct?.site_zip ?? null,
      status: "ready_to_schedule" as const,
      target_start: wo.scheduled_start_date,
      target_end: wo.scheduled_end_date,
      division_tag: "commercial",
      created_by_user_id: actorUserId,
    };
    // Try the readable code, then a collision-proof one, so a rare code clash can
    // never leave a sent WO unschedulable.
    for (const code of [baseCode, `${baseCode}-${workOrderId.slice(6, 12).toUpperCase()}`]) {
      const { data: inserted, error } = await sb
        .from("commercial_jobs")
        .insert({ job_code: code, ...jobRow })
        .select("id")
        .single();
      if (!error && inserted) {
        await logInsert("commercial_jobs", (inserted as { id: string }).id, inserted, actorUserId);
        return { ok: true, jobId: (inserted as { id: string }).id, created: true };
      }
      if (error && !/duplicate key|unique/i.test(error.message)) {
        return { ok: false, error: error.message };
      }
    }
    return { ok: false, error: "Could not create a schedulable work order (code conflict)." };
  } catch (err) {
    console.warn("[field-ops] ensureJobForWorkOrder failed:", err);
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Safety net: make sure EVERY sent deal Work Order has a live schedulable twin.
 * Run on the Calendar / Work Orders load so a WO that missed its create at
 * send-time (or was created then deleted) still shows up. Cheap + idempotent.
 */
export async function ensureJobsForSentWorkOrders(actorUserId: string): Promise<{ created: number; failed: number }> {
  try {
    const sb = commercialDb();
    const { data: wos } = await sb.from("commercial_work_orders").select("id").eq("status", "sent");
    let created = 0;
    let failed = 0;
    for (const w of (wos ?? []) as { id: string }[]) {
      const res = await ensureJobForWorkOrder(w.id, actorUserId);
      if (!res.ok) failed++;
      else if (res.created) created++;
    }
    return { created, failed };
  } catch {
    return { created: 0, failed: 0 };
  }
}

export async function softDeleteJob(id: string, actorUserId: string): Promise<{ ok: true } | { ok: false; error: string }> {
  const before = await getJob(id);
  if (!before) return { ok: false, error: "Job not found." };
  const sb = commercialDb();
  const { error } = await sb
    .from("commercial_jobs")
    .update({ deleted_at: new Date().toISOString(), deleted_by_user_id: actorUserId })
    .eq("id", id);
  if (error) return { ok: false, error: error.message };
  // Cancel this job's FUTURE assignments so crew aren't scheduled/emailed for a
  // dead work order. Past assignments stay for history + approval variance; the
  // clocked time_entries are a separate table and are never touched.
  const { data: affected } = await sb
    .from("commercial_assignments")
    .select("employee_id, work_date")
    .eq("job_id", id)
    .gte("work_date", todayEtIso())
    .neq("status", "cancelled");
  await sb
    .from("commercial_assignments")
    .update({ status: "cancelled", updated_at: new Date().toISOString() })
    .eq("job_id", id)
    .gte("work_date", todayEtIso())
    .neq("status", "cancelled");
  // Cancel the queued clock-in nudges for those now-dead shifts (audit #3) — one
  // reset per distinct (employee, day); the cron re-schedules any that still have
  // a surviving shift on another job that day.
  const pairs = new Set(((affected ?? []) as Array<{ employee_id: string; work_date: string }>).map((a) => `${a.employee_id}|${a.work_date}`));
  if (pairs.size > 0) {
    const { resetClockReminder } = await import("./schedule-email-send");
    for (const p of pairs) {
      const [emp, day] = p.split("|");
      await resetClockReminder(emp, day).catch(() => undefined);
    }
  }
  await logDelete("commercial_jobs", id, before, actorUserId);
  return { ok: true };
}
