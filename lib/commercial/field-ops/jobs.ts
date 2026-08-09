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

// Pure enums/labels live in job-constants.ts (client-safe); re-export for the
// many server callers that import them from here.
export {
  JOB_STATUSES,
  jobStatusLabel,
  DIVISION_TAGS,
  divisionLabel,
  type JobStatus,
  type DivisionTag,
} from "./job-constants";
import type { JobStatus, DivisionTag } from "./job-constants";

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
  "almost_done",
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
  // Only WON + ACTIVE deals belong here — what a crew could actually be
  // scheduled on. That's a freshly-won deal (pre_sale_closed + won) OR one in
  // delivery (pre_construction / in_progress / billing). Excludes pre-sale bids
  // (not won yet), lost deals, finished jobs (post_sale_closed), and — via the
  // guards below — deleted + archived. Karan 2026-08: "current is won/active."
  const { data: opps } = await sb
    .from("commercial_opportunities")
    .select("id, title, client_name, account_id")
    .is("deleted_at", null)
    .is("archived_at", null) // archived deals are hidden from the pipeline - hide them here too
    .or("and(status.eq.pre_sale_closed,sub_status.eq.won),status.in.(pre_construction,in_progress,billing)")
    .order("updated_at", { ascending: false })
    .limit(300);
  const all = (opps ?? []) as { id: string; title: string | null; client_name: string | null; account_id: string }[];
  // Exclude deals that ALREADY have a live field-ops work order — connecting one
  // deal twice would spawn a second job pointing at the same dashboard WO, split
  // payroll across two job codes, and show duplicate calendar cards (audit 2026-08).
  const { data: linked } = await sb
    .from("commercial_jobs")
    .select("opportunity_id")
    .not("opportunity_id", "is", null)
    .is("deleted_at", null);
  const taken = new Set(((linked ?? []) as { opportunity_id: string | null }[]).map((r) => r.opportunity_id).filter(Boolean) as string[]);
  const rows = all.filter((o) => !taken.has(o.id));
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

  // A deal can only own ONE live work order here — connecting it twice would spawn
  // a second job on the same dashboard WO, splitting payroll across two job codes
  // and duplicating calendar cards. The picker already excludes taken deals; this
  // backstops a stale form / direct call (audit round 2).
  if (input.opportunity_id) {
    const { data: dupOpp } = await sb
      .from("commercial_jobs")
      .select("id")
      .eq("opportunity_id", input.opportunity_id)
      .is("deleted_at", null)
      .limit(1)
      .maybeSingle();
    if (dupOpp) return { ok: false, error: "That deal already has a work order in Field Ops." };
  }

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
  // Connected to a deal but not already tied to a dashboard WO? Mirror it up so
  // it also shows on that deal's Work Orders tab (reverse of the send-time twin).
  if (job.opportunity_id && !job.work_order_id) {
    await ensureWorkOrderForJob(job.id, input.actor_user_id);
  }
  return { ok: true, job };
}

/**
 * Reverse of ensureJobForWorkOrder: when a Field Ops work order is connected to
 * a deal, make sure a dashboard Work Order (commercial_work_orders) exists for
 * that deal and link them — so the same work order shows on the deal's Work
 * Orders tab too, not just in Field Ops (Karan 2026-08: "if I connect a deal
 * here it should also go in the Work Order tab on the dashboard"). A one-off job
 * (no deal) creates nothing and stays only in Field Ops. Idempotent + never
 * throws; dynamic import avoids a static cycle with work-orders/db.ts.
 */
export async function ensureWorkOrderForJob(jobId: string, actorUserId: string): Promise<void> {
  try {
    const job = await getJob(jobId);
    if (!job) return;
    if (!job.opportunity_id) return; // one-off — stays in Field Ops only
    if (job.work_order_id) return; // already linked to a dashboard WO
    const { createWorkOrder } = await import("@/lib/commercial/work-orders/db");
    const res = await createWorkOrder({ opportunity_id: job.opportunity_id, created_by_user_id: actorUserId });
    if (!res.ok) return;
    const sb = commercialDb();
    await sb
      .from("commercial_jobs")
      .update({ work_order_id: res.value.id, updated_at: new Date().toISOString() })
      .eq("id", jobId);
  } catch (err) {
    console.warn("[field-ops] ensureWorkOrderForJob failed:", err);
  }
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
      // Revive the most recent soft-deleted twin — WITHOUT clobbering its status
      // (a revive on re-send must not silently reset an in_progress job to
      // ready_to_schedule; audit round 2).
      const reviveId = all[0].id;
      const { error } = await sb
        .from("commercial_jobs")
        .update({ deleted_at: null, deleted_by_user_id: null, updated_at: new Date().toISOString() })
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

    // ADOPT before inserting: a manual field-ops WO for this deal may already
    // exist with work_order_id still null (its up-mirror hadn't linked yet, or
    // failed transiently). Link that job to this WO instead of creating a SECOND
    // live job on the same deal — otherwise the deal splits across two job codes
    // (duplicate calendar cards + split payroll). The work_order_id dedupe above
    // misses it precisely because its work_order_id is null (audit round 3).
    if (wo.opportunity_id) {
      const { data: adoptable } = await sb
        .from("commercial_jobs")
        .select("id")
        .eq("opportunity_id", wo.opportunity_id)
        .is("work_order_id", null)
        .is("deleted_at", null)
        .limit(1)
        .maybeSingle();
      if (adoptable) {
        const adoptId = (adoptable as { id: string }).id;
        const { error } = await sb
          .from("commercial_jobs")
          .update({ work_order_id: workOrderId, updated_at: new Date().toISOString() })
          .eq("id", adoptId);
        if (error) return { ok: false, error: error.message };
        await logUpdate("commercial_jobs", adoptId, { work_order_id: null }, { work_order_id: workOrderId }, actorUserId);
        return { ok: true, jobId: adoptId, created: false };
      }
    }

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

/**
 * Reverse backfill: every LIVE deal-connected job with no dashboard WO yet gets
 * one (so it surfaces on the deal's Work Orders tab). Run on the Work Orders /
 * Status load alongside ensureJobsForSentWorkOrders. Cheap + idempotent — a job
 * that already has work_order_id is skipped by ensureWorkOrderForJob.
 */
export async function ensureWorkOrdersForConnectedJobs(actorUserId: string): Promise<void> {
  try {
    const sb = commercialDb();
    const { data: rows } = await sb
      .from("commercial_jobs")
      .select("id")
      .not("opportunity_id", "is", null)
      .is("work_order_id", null)
      .is("deleted_at", null)
      .limit(200);
    for (const r of (rows ?? []) as { id: string }[]) {
      await ensureWorkOrderForJob(r.id, actorUserId);
    }
  } catch (err) {
    console.warn("[field-ops] ensureWorkOrdersForConnectedJobs failed:", err);
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
  // Re-sync the queued clock-in nudges for those now-dead shifts — one per
  // distinct (employee, day). resync (not bare reset) so a crew member who still
  // has a surviving shift on ANOTHER job that day keeps a correctly-timed nudge
  // (audit round 2 — the once-daily cron can't fix a same-day delete).
  const pairs = new Set(((affected ?? []) as Array<{ employee_id: string; work_date: string }>).map((a) => `${a.employee_id}|${a.work_date}`));
  if (pairs.size > 0) {
    const { resyncClockReminder } = await import("./schedule-email-send");
    for (const p of pairs) {
      const [emp, day] = p.split("|");
      await resyncClockReminder(emp, day).catch(() => undefined);
    }
  }
  // If this job was the schedulable twin of a SENT deal Work Order, reopen that
  // WO to draft — otherwise the sent-WO backfill (ensureJobsForSentWorkOrders)
  // resurrects this job on the next page load, so the delete never sticks (audit
  // round 2). Re-sending the WO later revives the job intentionally.
  if (before.work_order_id) {
    const { data: woSent } = await sb
      .from("commercial_work_orders")
      .select("id")
      .eq("id", before.work_order_id)
      .eq("status", "sent")
      .maybeSingle();
    if (woSent) {
      // Match the canonical reopen (changeWorkOrderStatus → draft): clear sent_at
      // AND the frozen snapshot, else the deal's WO tool shows a stale "Last sent"
      // line + wrong header date on a WO that is no longer sent (audit round 5).
      await sb
        .from("commercial_work_orders")
        .update({ status: "draft", sent_at: null, snapshot_document_id: null, updated_at: new Date().toISOString() })
        .eq("id", before.work_order_id);
      await logUpdate("commercial_work_orders", before.work_order_id, { status: "sent" }, { status: "draft", sent_at: null }, actorUserId);
    }
  }
  await logDelete("commercial_jobs", id, before, actorUserId);
  return { ok: true };
}
