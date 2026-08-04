import "server-only";

import { commercialDb } from "@/lib/commercial/db";
import { logInsert, logUpdate, logDelete } from "@/lib/commercial/audit-log";

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

export async function createJob(
  input: CreateJobInput
): Promise<{ ok: true; job: CommercialJob } | { ok: false; error: string }> {
  const code = (input.job_code ?? "").trim();
  const name = (input.name ?? "").trim();
  if (!code) return { ok: false, error: "A job code is required — it's what makes labor reportable." };
  if (!name) return { ok: false, error: "Job name is required." };

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

export async function softDeleteJob(id: string, actorUserId: string): Promise<{ ok: true } | { ok: false; error: string }> {
  const before = await getJob(id);
  if (!before) return { ok: false, error: "Job not found." };
  const sb = commercialDb();
  const { error } = await sb
    .from("commercial_jobs")
    .update({ deleted_at: new Date().toISOString(), deleted_by_user_id: actorUserId })
    .eq("id", id);
  if (error) return { ok: false, error: error.message };
  await logDelete("commercial_jobs", id, before, actorUserId);
  return { ok: true };
}
